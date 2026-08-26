import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { spawn } from 'node:child_process';
import { digest, validateGrant, WorkspaceTargetResolver } from './shared';

export interface ProcessArgs extends Record<string, unknown> {
  executable: string;
  arguments: string[];
  timeoutMs?: number;
  expectedExitCode?: number;
}

interface ProcessObservation {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytesCaptured?: number;
  stderrBytesCaptured?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  cancelled?: boolean;
  sandboxBackend?: string;
}

async function readProcessStream(
  stream: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
): Promise<{ text: string; bytesCaptured: number; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let bytesCaptured = 0;
  let totalBytes = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    totalBytes += bytes.length;
    const remaining = Math.max(0, maximumBytes - bytesCaptured);
    if (remaining > 0) {
      const retained = bytes.slice(0, remaining);
      chunks.push(retained);
      bytesCaptured += retained.length;
    }
  }
  const retained = new Uint8Array(bytesCaptured);
  let offset = 0;
  for (const chunk of chunks) {
    retained.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    text: new TextDecoder().decode(retained),
    bytesCaptured,
    truncated: totalBytes > bytesCaptured,
  };
}

export interface BoundedProcessOptions {
  allowedExecutables: string[];
  environment?: Record<string, string>;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  sandboxBackend?: ProcessSandboxBackend;
}

export interface ProcessSandboxBackend {
  id: string;
  probe(): Promise<{ available: boolean; detail: string }>;
  command(input: { workspaceRoot: string; cwd: string; executable: string; arguments: string[] }): string[];
}

export class BubblewrapSandboxBackend implements ProcessSandboxBackend {
  readonly id = 'linux:bubblewrap';
  constructor(private readonly executable = 'bwrap') {}

  async probe(): Promise<{ available: boolean; detail: string }> {
    try {
      const child = Bun.spawn([this.executable, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const exitCode = await child.exited;
      return { available: exitCode === 0, detail: exitCode === 0 ? 'bubblewrap available' : `bubblewrap exited ${exitCode}` };
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  command(input: { workspaceRoot: string; cwd: string; executable: string; arguments: string[] }): string[] {
    const relativeCwd = input.cwd.slice(input.workspaceRoot.length).replace(/^\//, '');
    const bindSystem = ['/usr', '/bin', '/lib', '/lib64'].flatMap(path => ['--ro-bind-try', path, path]);
    return [
      this.executable,
      '--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev',
      ...bindSystem,
      '--bind', input.workspaceRoot, '/workspace', '--chdir', relativeCwd ? `/workspace/${relativeCwd}` : '/workspace',
      '--', input.executable, ...input.arguments,
    ];
  }
}

export interface OciContainerSandboxOptions {
  runtime?: 'docker' | 'podman';
  /** Use an immutable digest in production, for example image@sha256:... */
  image: string;
  memoryMb?: number;
  pidsLimit?: number;
}

export class OciContainerSandboxBackend implements ProcessSandboxBackend {
  readonly id: string;
  private readonly runtime: 'docker' | 'podman';

  constructor(private readonly options: OciContainerSandboxOptions) {
    this.runtime = options.runtime ?? 'docker';
    this.id = `oci:${this.runtime}`;
    if (!options.image.includes('@sha256:')) {
      throw new Error('OCI sandbox images must be pinned by sha256 digest.');
    }
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    try {
      const child = Bun.spawn([this.runtime, 'info', '--format', '{{json .ServerVersion}}'], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const exitCode = await child.exited;
      return {
        available: exitCode === 0,
        detail: exitCode === 0 ? `${this.runtime} isolation available` : `${this.runtime} info exited ${exitCode}`,
      };
    } catch (error) {
      return { available: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  command(input: { workspaceRoot: string; cwd: string; executable: string; arguments: string[] }): string[] {
    const relativeCwd = input.cwd.slice(input.workspaceRoot.length).replace(/^\//, '');
    return [
      this.runtime, 'run', '--rm', '--init', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.options.pidsLimit ?? 128),
      '--memory', `${this.options.memoryMb ?? 512}m`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,src=${input.workspaceRoot},dst=/workspace,rw`,
      '--workdir', relativeCwd ? `/workspace/${relativeCwd}` : '/workspace',
      this.options.image,
      input.executable,
      ...input.arguments,
    ];
  }
}

export class BoundedProcessCapability implements CapabilityAdapter<ProcessArgs> {
  readonly manifest: CapabilityManifest;

  private readonly resolver: WorkspaceTargetResolver;
  private readonly results = new Map<string, ProcessObservation>();

  constructor(root: string, private readonly options: BoundedProcessOptions) {
    this.resolver = new WorkspaceTargetResolver(root);
    this.manifest = {
      id: 'workspace.process.run',
      version: '0.3.0',
      effects: ['process.execute', 'state.read'],
      requiredEffects: ['process.execute'],
      // `workspace/` is the explicit process working-directory root. Keep the
      // descendant pattern separate: recursive patterns intentionally do not
      // match their bare container at the policy boundary.
      targetPatterns: ['workspace/', 'workspace/**'],
      riskCeiling: 4,
      approval: 'risk_based',
      idempotent: false,
      verification: 'required',
      inputSchema: {
        type: 'object',
        required: ['executable', 'arguments'],
        properties: {
          executable: {
            type: 'string',
            enum: [...new Set(options.allowedExecutables)],
            description: 'Choose one exact server-configured executable from this allowlist.',
          },
          arguments: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'integer' },
          expectedExitCode: { type: 'integer' },
        },
        additionalProperties: false,
      },
    };
  }

  async execute(
    proposal: ActionProposal<ProcessArgs>,
    grant: CapabilityGrant,
    signal?: AbortSignal,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'process.execute');
    if (invalid) return invalid;
    if (!this.options.allowedExecutables.includes(proposal.args.executable)) {
      return {
        success: false,
        summary: 'Executable is not in the capability allowlist.',
        errorCode: 'EXECUTABLE_NOT_ALLOWED',
        evidence: [],
      };
    }
    if (signal?.aborted) {
      return {
        success: false,
        summary: 'Process was cancelled before execution.',
        errorCode: 'PROCESS_CANCELLED',
        effectState: 'not_started',
        retrySafe: true,
        reconciliationRequired: false,
        evidence: [],
      };
    }

    try {
      const cwd = this.resolver.resolve(proposal.target, false, true);
      const timeoutMs = Math.min(
        proposal.args.timeoutMs ?? 30_000,
        this.options.maxTimeoutMs ?? 60_000,
      );
      const max = Math.max(0, this.options.maxOutputBytes ?? 200_000);
      let command = [proposal.args.executable, ...proposal.args.arguments];
      let sandboxAttestation: { backend: string; detail: string } | undefined;
      if (this.options.sandboxBackend) {
        const probe = await this.options.sandboxBackend.probe();
        if (!probe.available) {
          return { success: false, summary: `Configured sandbox is unavailable: ${probe.detail}`, errorCode: 'SANDBOX_UNAVAILABLE', evidence: [] };
        }
        command = this.options.sandboxBackend.command({
          workspaceRoot: this.resolver.root,
          cwd,
          executable: proposal.args.executable,
          arguments: proposal.args.arguments,
        });
        sandboxAttestation = { backend: this.options.sandboxBackend.id, detail: probe.detail };
      }
      const child = spawn(command[0]!, command.slice(1), {
          cwd,
          env: this.options.environment ?? {},
          stdio: ['ignore', 'pipe', 'pipe'],
        });

      let timedOut = false;
      let cancelled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      const abort = () => {
        cancelled = true;
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', abort, { once: true });
      const exited = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code ?? -1));
      });
      let stdout;
      let stderr;
      let exitCode;
      try {
        [stdout, stderr, exitCode] = await Promise.all([
          readProcessStream(child.stdout!, max),
          readProcessStream(child.stderr!, max),
          exited,
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      const result: ProcessObservation = {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytesCaptured: stdout.bytesCaptured,
        stderrBytesCaptured: stderr.bytesCaptured,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        cancelled,
        ...(sandboxAttestation ? { sandboxBackend: sandboxAttestation.backend } : {}),
      };
      this.results.set(proposal.id, result);
      const expected = proposal.args.expectedExitCode ?? 0;
      return {
        success: !timedOut && !cancelled && exitCode === expected,
        summary: cancelled
          ? 'Process was cancelled after execution started.'
          : timedOut
          ? `Process exceeded ${timeoutMs}ms timeout.`
          : `Process exited with code ${exitCode}.`,
        errorCode: cancelled ? 'PROCESS_CANCELLED' : timedOut ? 'PROCESS_TIMEOUT' : exitCode === expected ? undefined : 'UNEXPECTED_EXIT_CODE',
        failureObservationAvailable: cancelled || timedOut || exitCode !== expected,
        effectState: cancelled || timedOut ? 'partially_applied' : 'applied',
        retrySafe: !cancelled && !timedOut && exitCode === expected,
        reconciliationRequired: cancelled || timedOut,
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest({ result, sandboxAttestation }),
        }],
      };
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'PROCESS_EXECUTION_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<ProcessArgs>): Promise<Observation> {
    const result = this.results.get(proposal.id);
    return {
      target: proposal.target,
      exists: !!result,
      value: result,
      evidence: [{
        id: `observation:${proposal.id}`,
        kind: 'observation',
        source: this.manifest.id,
        digest: digest(result ?? { missing: true }),
      }],
    };
  }

  async verify(
    proposal: ActionProposal<ProcessArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const value = observation.value as ProcessObservation | undefined;
    const expected = proposal.args.expectedExitCode ?? 0;
    const passed = execution.success
      && observation.exists
      && !value?.timedOut
      && value?.exitCode === expected;
    return {
      passed,
      reasonCodes: passed ? ['PROCESS_EXIT_OBSERVED'] : ['PROCESS_RESULT_NOT_VERIFIED'],
      evidence: observation.evidence,
    };
  }
}

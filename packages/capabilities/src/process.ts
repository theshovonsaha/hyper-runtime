import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
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
  timedOut: boolean;
  sandboxBackend?: string;
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
  readonly manifest: CapabilityManifest = {
    id: 'workspace.process.run',
    version: '0.2.0',
    effects: ['process.execute', 'state.read'],
    requiredEffects: ['process.execute'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'risk_based',
    idempotent: false,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['executable', 'arguments'],
      properties: {
        executable: { type: 'string' },
        arguments: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'integer' },
        expectedExitCode: { type: 'integer' },
      },
      additionalProperties: false,
    },
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly results = new Map<string, ProcessObservation>();

  constructor(root: string, private readonly options: BoundedProcessOptions) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  async execute(
    proposal: ActionProposal<ProcessArgs>,
    grant: CapabilityGrant,
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

    try {
      const cwd = this.resolver.resolve(proposal.target);
      const timeoutMs = Math.min(
        proposal.args.timeoutMs ?? 30_000,
        this.options.maxTimeoutMs ?? 60_000,
      );
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
      const child = Bun.spawn(
        command,
        {
          cwd,
          env: this.options.environment ?? {},
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);

      const max = this.options.maxOutputBytes ?? 200_000;
      const result: ProcessObservation = {
        exitCode,
        stdout: stdoutRaw.slice(0, max),
        stderr: stderrRaw.slice(0, max),
        timedOut,
        ...(sandboxAttestation ? { sandboxBackend: sandboxAttestation.backend } : {}),
      };
      this.results.set(proposal.id, result);
      const expected = proposal.args.expectedExitCode ?? 0;
      return {
        success: !timedOut && exitCode === expected,
        summary: timedOut
          ? `Process exceeded ${timeoutMs}ms timeout.`
          : `Process exited with code ${exitCode}.`,
        errorCode: timedOut ? 'PROCESS_TIMEOUT' : exitCode === expected ? undefined : 'UNEXPECTED_EXIT_CODE',
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

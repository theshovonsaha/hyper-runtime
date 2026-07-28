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
}

export interface BoundedProcessOptions {
  allowedExecutables: string[];
  environment?: Record<string, string>;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
}

export class BoundedProcessCapability implements CapabilityAdapter<ProcessArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.process.run',
    version: '0.2.0',
    effects: ['process.execute', 'state.read'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'risk_based',
    idempotent: false,
    verification: 'required',
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
      const child = Bun.spawn(
        [proposal.args.executable, ...proposal.args.arguments],
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
          digest: digest(result),
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

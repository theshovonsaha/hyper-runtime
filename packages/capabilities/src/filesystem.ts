import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

export interface FileReadArgs extends Record<string, unknown> {
  expectedSha256?: string;
  maxBytes?: number;
}

export interface FileWriteArgs extends Record<string, unknown> {
  content: string;
  expectedPreviousSha256?: string;
}

async function readUtf8(path: string, maxBytes = 1_000_000): Promise<string> {
  const info = await stat(path);
  if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit.`);
  return readFile(path, 'utf8');
}

export class ReadFileCapability implements CapabilityAdapter<FileReadArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.file.read',
    version: '0.2.0',
    effects: ['state.read'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 2,
    approval: 'never',
    idempotent: true,
    verification: 'required',
  };

  private readonly resolver: WorkspaceTargetResolver;

  constructor(root: string) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  async execute(
    proposal: ActionProposal<FileReadArgs>,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.read');
    if (invalid) return invalid;
    try {
      const content = await readUtf8(
        this.resolver.resolve(proposal.target),
        proposal.args.maxBytes ?? 1_000_000,
      );
      return {
        success: true,
        summary: `Read ${Buffer.byteLength(content)} bytes from ${proposal.target}.`,
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest(content),
        }],
      };
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'FILE_READ_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<FileReadArgs>): Promise<Observation> {
    try {
      const content = await readUtf8(
        this.resolver.resolve(proposal.target),
        proposal.args.maxBytes ?? 1_000_000,
      );
      return {
        target: proposal.target,
        exists: true,
        value: content,
        evidence: [{
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest(content),
        }],
      };
    } catch {
      return {
        target: proposal.target,
        exists: false,
        evidence: [{
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest({ exists: false }),
        }],
      };
    }
  }

  async verify(
    proposal: ActionProposal<FileReadArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const observedDigest = observation.exists ? digest(observation.value) : undefined;
    const passed = execution.success
      && observation.exists
      && (!proposal.args.expectedSha256 || proposal.args.expectedSha256 === observedDigest);
    return {
      passed,
      reasonCodes: passed ? ['FILE_READ_OBSERVED'] : ['FILE_READ_NOT_VERIFIED'],
      evidence: observation.evidence,
    };
  }
}

export class WriteFileCapability implements CapabilityAdapter<FileWriteArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.file.write',
    version: '0.2.0',
    effects: ['state.write'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'risk_based',
    idempotent: true,
    verification: 'required',
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly idempotency = new Map<string, CapabilityExecution>();

  constructor(root: string) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  async execute(
    proposal: ActionProposal<FileWriteArgs>,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.write');
    if (invalid) return invalid;
    const previous = this.idempotency.get(proposal.idempotencyKey);
    if (previous) return structuredClone(previous);

    try {
      const path = this.resolver.resolve(proposal.target, true);
      let current: string | undefined;
      try {
        current = await readFile(path, 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (
        proposal.args.expectedPreviousSha256
        && digest(current ?? '') !== proposal.args.expectedPreviousSha256
      ) {
        return {
          success: false,
          summary: 'Current file digest does not match the proposal precondition.',
          errorCode: 'STALE_FILE_PRECONDITION',
          evidence: [],
        };
      }

      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.hyper-${digest(proposal.id).slice(0, 12)}.tmp`;
      await writeFile(temporary, proposal.args.content, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);

      const execution: CapabilityExecution = {
        success: true,
        summary: `Atomically wrote ${Buffer.byteLength(proposal.args.content)} bytes.`,
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest(proposal.args.content),
        }],
      };
      this.idempotency.set(proposal.idempotencyKey, execution);
      return structuredClone(execution);
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'FILE_WRITE_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<FileWriteArgs>): Promise<Observation> {
    try {
      const content = await readUtf8(this.resolver.resolve(proposal.target));
      return {
        target: proposal.target,
        exists: true,
        value: content,
        evidence: [{
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest(content),
        }],
      };
    } catch {
      return {
        target: proposal.target,
        exists: false,
        evidence: [{
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest({ exists: false }),
        }],
      };
    }
  }

  async verify(
    proposal: ActionProposal<FileWriteArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const passed = execution.success
      && observation.exists
      && observation.value === proposal.args.content;
    return {
      passed,
      reasonCodes: passed ? ['FILE_CONTENT_OBSERVED'] : ['FILE_CONTENT_MISMATCH'],
      evidence: observation.evidence,
    };
  }
}

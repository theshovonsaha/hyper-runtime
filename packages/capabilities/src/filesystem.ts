import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  EffectReconciliation,
  FileSliceObservation,
  InterruptedEffect,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { digest, validateGrant, WorkspaceTargetResolver } from './shared';

export interface FileReadArgs extends Record<string, unknown> {
  expectedSha256?: string;
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
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

async function readUtf8Slice(path: string, args: FileReadArgs, displayPath: string): Promise<FileSliceObservation> {
  const content = await readUtf8(path, args.maxBytes ?? 1_000_000);
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  const totalLines = Math.max(1, starts.length);
  const startLine = args.startLine ?? 1;
  const endLine = args.endLine ?? totalLines;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine > totalLines) {
    throw new Error(`Invalid line range ${startLine}-${endLine}; file has ${totalLines} lines.`);
  }
  if (endLine - startLine + 1 > 2_000) throw new Error('A file read is limited to 2,000 lines.');
  const startCharacter = starts[startLine - 1]!;
  const endCharacter = endLine < totalLines ? starts[endLine]! : content.length;
  const text = content.slice(startCharacter, endCharacter);
  const startByte = Buffer.byteLength(content.slice(0, startCharacter));
  return {
    path: displayPath,
    snapshotSha256: digest(content),
    sliceSha256: digest(text),
    startLine,
    endLine,
    totalLines,
    startByte,
    endByte: startByte + Buffer.byteLength(text),
    text,
    truncated: startLine > 1 || endLine < totalLines,
  };
}

export class ReadFileCapability implements CapabilityAdapter<FileReadArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.file.read',
    version: '0.2.0',
    effects: ['state.read'],
    requiredEffects: ['state.read'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 2,
    approval: 'never',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      properties: {
        expectedSha256: { type: 'string' },
        maxBytes: { type: 'integer' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      additionalProperties: false,
    },
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
      const slice = await readUtf8Slice(this.resolver.resolve(proposal.target), proposal.args, proposal.target);
      return {
        success: true,
        summary: `Read ${slice.path} lines ${slice.startLine}-${slice.endLine} (${slice.endByte - slice.startByte} bytes).`,
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: slice.sliceSha256,
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
      const slice = await readUtf8Slice(this.resolver.resolve(proposal.target), proposal.args, proposal.target);
      return {
        target: proposal.target,
        exists: true,
        value: slice,
        evidence: [{
          id: `observation:${proposal.id}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: slice.sliceSha256,
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
    const value = observation.value as FileSliceObservation | undefined;
    const observedDigest = value?.snapshotSha256;
    const executionDigest = execution.evidence.find(item => item.kind === 'tool_result')?.digest;
    const passed = execution.success
      && observation.exists
      && executionDigest === value?.sliceSha256
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
    requiredEffects: ['state.write'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'risk_based',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        expectedPreviousSha256: { type: 'string' },
      },
      additionalProperties: false,
    },
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

  async recoverInterrupted(effect: InterruptedEffect): Promise<EffectReconciliation> {
    const path = this.resolver.resolve(effect.target, true);
    const temporary = `${path}.hyper-${digest(effect.proposalId).slice(0, 12)}.tmp`;
    try {
      const staged = await readFile(temporary);
      await mkdir(dirname(path), { recursive: true });
      await rename(temporary, path);
      const contentDigest = digest(staged);
      return {
        effectId: effect.idempotencyKey,
        state: 'reconciled',
        retrySafe: true,
        summary: 'Recovered the prepared atomic file replacement without repeating the write.',
        evidence: [{
          id: `recovery:${effect.proposalId}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: contentDigest,
        }],
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    try {
      const content = await readFile(path);
      return {
        effectId: effect.idempotencyKey,
        state: 'applied',
        retrySafe: true,
        summary: 'The target exists; the interrupted write is treated as applied but not task-complete.',
        evidence: [{
          id: `recovery:${effect.proposalId}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest(content),
        }],
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return {
        effectId: effect.idempotencyKey,
        state: 'not_applied',
        retrySafe: true,
        summary: 'No staged file or target was found; a fresh authorized proposal may retry.',
        evidence: [{
          id: `recovery:${effect.proposalId}`,
          kind: 'observation',
          source: this.manifest.id,
          digest: digest({ target: effect.target, exists: false }),
        }],
      };
    }
  }
}

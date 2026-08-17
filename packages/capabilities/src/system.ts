import { readdir, stat } from 'node:fs/promises';
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

export interface ListDirectoryArgs extends Record<string, unknown> {
  maxEntries?: number;
  includeHidden?: boolean;
}

interface DirectoryEntryObservation {
  name: string;
  kind: 'file' | 'directory' | 'other';
  size?: number;
}

export class ListDirectoryCapability implements CapabilityAdapter<ListDirectoryArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.directory.list',
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
        maxEntries: { type: 'integer' },
        includeHidden: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  };
  private readonly resolver: WorkspaceTargetResolver;
  private readonly observations = new Map<string, DirectoryEntryObservation[]>();

  constructor(root: string) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  private async list(proposal: ActionProposal<ListDirectoryArgs>): Promise<DirectoryEntryObservation[]> {
    const path = this.resolver.resolve(proposal.target, false, true);
    if (!(await stat(path)).isDirectory()) throw new Error('Target is not a directory.');
    const max = Math.min(Math.max(proposal.args.maxEntries ?? 200, 1), 1_000);
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter(entry => proposal.args.includeHidden === true || !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, max)
      .map(entry => ({
        name: entry.name,
        kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
      }));
  }

  async execute(proposal: ActionProposal<ListDirectoryArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.read');
    if (invalid) return invalid;
    try {
      const entries = await this.list(proposal);
      this.observations.set(proposal.id, entries);
      return {
        success: true,
        summary: `Listed ${entries.length} bounded entries from ${proposal.target}.`,
        evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(entries) }],
      };
    } catch (error) {
      return { success: false, summary: error instanceof Error ? error.message : String(error), errorCode: 'DIRECTORY_LIST_FAILED', evidence: [] };
    }
  }

  async observe(proposal: ActionProposal<ListDirectoryArgs>): Promise<Observation> {
    try {
      const entries = await this.list(proposal);
      return {
        target: proposal.target,
        exists: true,
        value: entries,
        evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(entries) }],
      };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ exists: false }) }] };
    }
  }

  async verify(proposal: ActionProposal<ListDirectoryArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    const expected = this.observations.get(proposal.id);
    const passed = execution.success && observation.exists && digest(expected) === digest(observation.value);
    return { passed, reasonCodes: passed ? ['DIRECTORY_LIST_OBSERVED'] : ['DIRECTORY_LIST_CHANGED_OR_MISSING'], evidence: observation.evidence };
  }
}

export interface ClockArgs extends Record<string, unknown> {
  timezone: string;
}

interface ClockObservation {
  instant: string;
  timezone: string;
  local: string;
}

export class ReplayableClockCapability implements CapabilityAdapter<ClockArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'system.clock.read',
    version: '0.2.0',
    effects: ['state.read'],
    requiredEffects: ['state.read'],
    targetPatterns: ['clock://now'],
    riskCeiling: 1,
    approval: 'never',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['timezone'],
      properties: { timezone: { type: 'string' } },
      additionalProperties: false,
    },
  };
  private readonly values = new Map<string, ClockObservation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private read(proposal: ActionProposal<ClockArgs>): ClockObservation {
    if (proposal.target !== 'clock://now') throw new Error('Clock target must be clock://now.');
    const instant = this.now();
    const timezone = proposal.args.timezone.slice(0, 100);
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(instant);
    return { instant: instant.toISOString(), timezone, local };
  }

  async execute(proposal: ActionProposal<ClockArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.read');
    if (invalid) return invalid;
    try {
      const value = this.read(proposal);
      this.values.set(proposal.id, value);
      return { success: true, summary: `Captured replayable time ${value.instant} in ${value.timezone}.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(value) }] };
    } catch (error) {
      return { success: false, summary: error instanceof Error ? error.message : String(error), errorCode: 'CLOCK_READ_FAILED', evidence: [] };
    }
  }

  async observe(proposal: ActionProposal<ClockArgs>): Promise<Observation> {
    const value = this.values.get(proposal.id);
    return { target: proposal.target, exists: !!value, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { missing: true }) }] };
  }

  async verify(_proposal: ActionProposal<ClockArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    const passed = execution.success && observation.exists;
    return { passed, reasonCodes: passed ? ['CLOCK_SNAPSHOT_OBSERVED'] : ['CLOCK_SNAPSHOT_MISSING'], evidence: observation.evidence };
  }
}

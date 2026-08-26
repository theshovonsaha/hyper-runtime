import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
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

export interface RepositorySearchArgs extends Record<string, unknown> {
  query: string;
  caseSensitive?: boolean;
  fileExtensions?: string[];
  includeHidden?: boolean;
  maxResults?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface RepositorySearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  snapshotSha256: string;
}

export interface RepositorySearchObservation {
  query: string;
  root: string;
  matches: RepositorySearchMatch[];
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'target', '__pycache__',
]);

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}

function normalizedExtensions(values: string[] | undefined): Set<string> | undefined {
  if (!values?.length) return undefined;
  return new Set(values.slice(0, 50).map(value => {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
  }).filter(value => /^\.[a-z0-9][a-z0-9+._-]{0,15}$/i.test(value)));
}

export class RepositorySearchCapability implements CapabilityAdapter<RepositorySearchArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.repository.search',
    version: '0.2.0',
    description: 'Search bounded UTF-8 workspace files below a directory and return exact line matches with snapshot digests. The target must be a directory such as workspace/ or workspace/lib; use workspace.file.read to inspect a known file.',
    effects: ['state.read'],
    requiredEffects: ['state.read'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 2,
    approval: 'never',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        fileExtensions: { type: 'array', items: { type: 'string' } },
        includeHidden: { type: 'boolean' },
        maxResults: { type: 'integer' },
        maxFiles: { type: 'integer' },
        maxFileBytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly executed = new Map<string, RepositorySearchObservation>();

  constructor(root: string) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  private async search(proposal: ActionProposal<RepositorySearchArgs>): Promise<RepositorySearchObservation> {
    const query = proposal.args.query;
    if (!query || query.length > 500) throw new Error('Search query must contain 1-500 characters.');
    if (query.includes('\0')) throw new Error('Search query contains an invalid null character.');
    const root = this.resolver.resolve(proposal.target, false, true);
    if (!(await stat(root)).isDirectory()) throw new Error('Repository search target must be a directory.');
    const maxResults = boundedInteger(proposal.args.maxResults, 100, 500);
    const maxFiles = boundedInteger(proposal.args.maxFiles, 2_000, 10_000);
    const maxFileBytes = boundedInteger(proposal.args.maxFileBytes, 1_000_000, 4_000_000);
    const extensions = normalizedExtensions(proposal.args.fileExtensions);
    const needle = proposal.args.caseSensitive ? query : query.toLowerCase();
    const matches: RepositorySearchMatch[] = [];
    const directories = [root];
    let filesScanned = 0;
    let filesSkipped = 0;
    let truncated = false;

    while (directories.length > 0 && filesScanned < maxFiles && matches.length < maxResults) {
      const directory = directories.pop()!;
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (matches.length >= maxResults || filesScanned >= maxFiles) {
          truncated = true;
          break;
        }
        if (entry.isSymbolicLink()) {
          filesSkipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if ((!proposal.args.includeHidden && entry.name.startsWith('.')) || DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
            filesSkipped += 1;
          } else {
            directories.push(this.resolver.resolve(`workspace/${relative(this.resolver.root, join(directory, entry.name)).split(sep).join('/')}`));
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (!proposal.args.includeHidden && entry.name.startsWith('.')) {
          filesSkipped += 1;
          continue;
        }
        const extension = entry.name.includes('.') ? `.${entry.name.split('.').at(-1)!.toLowerCase()}` : '';
        if (extensions && !extensions.has(extension)) continue;
        const target = `workspace/${relative(this.resolver.root, join(directory, entry.name)).split(sep).join('/')}`;
        const path = this.resolver.resolve(target);
        const info = await stat(path);
        if (info.size > maxFileBytes) {
          filesSkipped += 1;
          continue;
        }
        const bytes = await readFile(path);
        if (bytes.includes(0)) {
          filesSkipped += 1;
          continue;
        }
        const content = bytes.toString('utf8');
        filesScanned += 1;
        const snapshotSha256 = digest(content);
        const lines = content.split('\n');
        for (const [index, line] of lines.entries()) {
          const searchable = proposal.args.caseSensitive ? line : line.toLowerCase();
          let offset = 0;
          while (offset <= searchable.length) {
            const column = searchable.indexOf(needle, offset);
            if (column < 0) break;
            matches.push({
              path: target,
              line: index + 1,
              column: column + 1,
              preview: line.slice(0, 500),
              snapshotSha256,
            });
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }
            offset = column + Math.max(needle.length, 1);
          }
          if (matches.length >= maxResults) break;
        }
      }
    }
    if (directories.length > 0 || filesScanned >= maxFiles) truncated = true;
    return { query, root: proposal.target, matches, filesScanned, filesSkipped, truncated };
  }

  async execute(proposal: ActionProposal<RepositorySearchArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.read');
    if (invalid) return invalid;
    try {
      const result = await this.search(proposal);
      this.executed.set(proposal.id, result);
      return {
        success: true,
        summary: `Found ${result.matches.length} bounded matches across ${result.filesScanned} files.`,
        evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(result) }],
      };
    } catch (error) {
      return { success: false, summary: error instanceof Error ? error.message : String(error), errorCode: 'REPOSITORY_SEARCH_FAILED', evidence: [] };
    }
  }

  async observe(proposal: ActionProposal<RepositorySearchArgs>): Promise<Observation> {
    try {
      const value = await this.search(proposal);
      return {
        target: proposal.target,
        exists: true,
        value,
        evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value) }],
      };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ exists: false }) }] };
    }
  }

  async verify(proposal: ActionProposal<RepositorySearchArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    const expected = this.executed.get(proposal.id);
    const passed = execution.success && observation.exists && digest(expected) === digest(observation.value);
    return {
      passed,
      reasonCodes: passed ? ['REPOSITORY_SEARCH_OBSERVED'] : ['REPOSITORY_SEARCH_CHANGED_OR_MISSING'],
      evidence: observation.evidence,
    };
  }
}

export interface PatchReplacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface PatchFileArgs extends Record<string, unknown> {
  expectedPreviousSha256: string;
  replacements: PatchReplacement[];
}

interface PatchObservation {
  path: string;
  previousSha256: string;
  newSha256: string;
  replacementsApplied: number;
  byteLength: number;
}

function occurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}

export class PatchFileCapability implements CapabilityAdapter<PatchFileArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'workspace.file.patch',
    version: '0.2.0',
    description: 'Apply exact stale-safe replacements to one previously inspected UTF-8 workspace file.',
    effects: ['state.write'],
    requiredEffects: ['state.write'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'risk_based',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['expectedPreviousSha256', 'replacements'],
      properties: {
        expectedPreviousSha256: { type: 'string' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            required: ['oldText', 'newText'],
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly completed = new Map<string, PatchObservation>();
  private readonly idempotency = new Map<string, CapabilityExecution>();

  constructor(root: string) {
    this.resolver = new WorkspaceTargetResolver(root);
  }

  async execute(proposal: ActionProposal<PatchFileArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'state.write');
    if (invalid) return invalid;
    const previousExecution = this.idempotency.get(proposal.idempotencyKey);
    if (previousExecution) return structuredClone(previousExecution);
    try {
      const path = this.resolver.resolve(proposal.target);
      const current = await readFile(path, 'utf8');
      if (Buffer.byteLength(current) > 2_000_000) throw new Error('Patch target exceeds the 2 MB limit.');
      const previousSha256 = digest(current);
      if (!/^[a-f0-9]{64}$/i.test(proposal.args.expectedPreviousSha256)
        || proposal.args.expectedPreviousSha256 !== previousSha256) {
        throw new Error('STALE_FILE_PRECONDITION: current file digest differs from the inspected snapshot.');
      }
      if (!Array.isArray(proposal.args.replacements) || proposal.args.replacements.length < 1 || proposal.args.replacements.length > 100) {
        throw new Error('Patch requires 1-100 exact replacements.');
      }
      let next = current;
      let replacementsApplied = 0;
      for (const replacement of proposal.args.replacements) {
        if (!replacement.oldText || replacement.oldText.length > 200_000 || replacement.newText.length > 200_000) {
          throw new Error('Each patch replacement must have bounded non-empty oldText.');
        }
        const count = occurrences(next, replacement.oldText);
        if (count === 0) throw new Error('PATCH_CONTEXT_NOT_FOUND: oldText does not occur in the inspected file.');
        if (!replacement.replaceAll && count !== 1) {
          throw new Error(`PATCH_CONTEXT_AMBIGUOUS: oldText occurs ${count} times; provide more context or set replaceAll.`);
        }
        if (replacement.replaceAll) {
          next = next.split(replacement.oldText).join(replacement.newText);
          replacementsApplied += count;
        } else {
          next = next.replace(replacement.oldText, replacement.newText);
          replacementsApplied += 1;
        }
      }
      if (next === current) throw new Error('Patch produced no file change.');
      const temporary = `${path}.hyper-patch-${digest(proposal.id).slice(0, 12)}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, next, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
      const observation: PatchObservation = {
        path: proposal.target,
        previousSha256,
        newSha256: digest(next),
        replacementsApplied,
        byteLength: Buffer.byteLength(next),
      };
      this.completed.set(proposal.id, observation);
      const execution: CapabilityExecution = {
        success: true,
        summary: `Atomically applied ${replacementsApplied} exact replacement(s) to ${proposal.target}.`,
        evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }],
      };
      this.idempotency.set(proposal.idempotencyKey, execution);
      return structuredClone(execution);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: message,
        errorCode: message.startsWith('STALE_FILE_PRECONDITION')
          ? 'STALE_FILE_PRECONDITION'
          : message.startsWith('PATCH_CONTEXT_') ? message.split(':')[0] : 'FILE_PATCH_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<PatchFileArgs>): Promise<Observation> {
    const expected = this.completed.get(proposal.id);
    if (!expected) {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ missing: true }) }] };
    }
    try {
      const current = await readFile(this.resolver.resolve(proposal.target), 'utf8');
      const value: PatchObservation = { ...expected, newSha256: digest(current), byteLength: Buffer.byteLength(current) };
      return {
        target: proposal.target,
        exists: true,
        value,
        evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value) }],
      };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ missing: true }) }] };
    }
  }

  async verify(proposal: ActionProposal<PatchFileArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    const expected = this.completed.get(proposal.id);
    const value = observation.value as PatchObservation | undefined;
    const passed = execution.success && observation.exists && !!expected
      && value?.newSha256 === expected.newSha256 && value?.byteLength === expected.byteLength;
    return {
      passed,
      reasonCodes: passed ? ['FILE_PATCH_OBSERVED'] : ['FILE_PATCH_NOT_VERIFIED'],
      evidence: observation.evidence,
    };
  }
}

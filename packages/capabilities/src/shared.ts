import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ActionProposal,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Effect,
} from '@hyper/contracts';

export function digest(value: unknown): string {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(source).digest('hex');
}

export function validateGrant(
  proposal: ActionProposal,
  grant: CapabilityGrant,
  manifest: CapabilityManifest,
  requiredEffect: Effect,
): CapabilityExecution | null {
  if (
    grant.proposalId !== proposal.id
    || grant.capabilityId !== manifest.id
    || grant.principalId !== proposal.principalId
    || grant.target !== proposal.target
    || !grant.effects.includes(requiredEffect)
  ) {
    return {
      success: false,
      summary: 'The capability grant does not authorize this invocation.',
      errorCode: 'INVALID_GRANT',
      evidence: [],
    };
  }
  return null;
}

export class WorkspaceTargetResolver {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  resolve(target: string, allowMissingLeaf = false): string {
    if (!target.startsWith('workspace/') || target.includes('\0')) {
      throw new Error('Target must be a workspace-relative resource.');
    }
    const relativeTarget = target.slice('workspace/'.length);
    if (!relativeTarget || isAbsolute(relativeTarget)) {
      throw new Error('Target must identify a workspace descendant.');
    }
    const candidate = resolve(this.root, relativeTarget);
    const relation = relative(this.root, candidate);
    if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error('Target escapes the configured workspace.');
    }

    const segments = relation.split(sep);
    let current = this.root;
    for (const [index, segment] of segments.entries()) {
      current = resolve(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error('Symbolic-link traversal is not allowed.');
        }
      } catch (error) {
        if (
          error instanceof Error
          && 'code' in error
          && error.code === 'ENOENT'
          && (allowMissingLeaf || index < segments.length)
        ) {
          continue;
        }
        throw error;
      }
    }
    return candidate;
  }
}

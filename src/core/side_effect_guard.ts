/**
 * core/side_effect_guard.ts — Deterministic Side-Effect Guard (Production Grade)
 *
 * Pre-verification pass running on generated responses before presentation.
 * Extracts specific target filepaths, URLs, and commands from claims and cross-references
 * them against empirical tool execution records and exact tool arguments.
 */

export interface ToolExecutionRecord {
  toolName: string;
  isFailure?: boolean;
  content?: string;
  args?: Record<string, unknown>;
}

export interface GuardCheckResult {
  passed: boolean;
  claimsDetected: Array<{ type: string; targetPath?: string }>;
  unsupportedClaims: Array<{ type: string; targetPath?: string; reason: string }>;
  annotatedText: string;
}

export class SideEffectGuard {
  private claimExtractors = [
    {
      type: 'file_write',
      regex: /\b(?:created|written|generated|saved)\s+(?:the\s+)?(?:file\s+)?['`"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)['`"]?/gi,
    },
    {
      type: 'file_edit',
      regex: /\b(?:modified|edited|patched|updated|refactored)\s+(?:the\s+)?(?:file\s+)?['`"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)['`"]?/gi,
    },
    {
      type: 'file_delete',
      regex: /\b(?:deleted|removed|wiped)\s+(?:the\s+)?(?:file\s+)?['`"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)['`"]?/gi,
    },
    {
      type: 'bash_exec',
      regex: /\b(?:executed|ran|started)\s+(?:the\s+)?(?:command|script|shell)\s+['`"]?([^'`"\n]+)['`"]?/gi,
    },
  ];

  /**
   * Extract target file path from tool record (either from args like `target_file`, `file`, `path`, or content).
   */
  private extractToolPath(record: ToolExecutionRecord): string | null {
    if (record.args) {
      for (const key of ['TargetFile', 'target_file', 'file', 'path', 'filepath', 'Target', 'target']) {
        if (typeof record.args[key] === 'string') {
          return (record.args[key] as string).toLowerCase().trim();
        }
      }
    }
    if (record.content) {
      const match = record.content.match(/(?:file|path|to):\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/i);
      if (match) return match[1].toLowerCase().trim();
    }
    return null;
  }

  /**
   * Evaluates generated text against turn tool execution records.
   */
  inspectResponse(
    response: string,
    toolExecutions: ToolExecutionRecord[]
  ): GuardCheckResult {
    // Honest failure reporting passes directly
    if (/\b(?:could not|failed to|unable to|error occurred|permission denied)\b/i.test(response)) {
      return {
        passed: true,
        claimsDetected: [],
        unsupportedClaims: [],
        annotatedText: response,
      };
    }

    const claimsDetected: Array<{ type: string; targetPath?: string }> = [];
    const unsupportedClaims: Array<{ type: string; targetPath?: string; reason: string }> = [];

    // Extract claims from text
    for (const extractor of this.claimExtractors) {
      const matches = Array.from(response.matchAll(extractor.regex));
      for (const match of matches) {
        const targetPath = match[1] ? match[1].toLowerCase().trim() : undefined;
        claimsDetected.push({ type: extractor.type, targetPath });
      }
    }

    // Generic fallback claim check if no specific path regex matched
    if (claimsDetected.length === 0) {
      if (/\b(?:I have|I've)\s+(?:created|modified|updated|deleted)\b/i.test(response)) {
        claimsDetected.push({ type: 'generic_action' });
      }
    }

    // Verify each claim against actual empirical tool executions
    for (const claim of claimsDetected) {
      const matchingExecs = toolExecutions.filter(exec => {
        if (exec.isFailure) return false;
        const name = exec.toolName.toLowerCase();

        if (claim.type === 'file_write') {
          return name.includes('write') || name.includes('create') || name.includes('bash');
        }
        if (claim.type === 'file_edit') {
          return name.includes('edit') || name.includes('replace') || name.includes('modify') || name.includes('write');
        }
        if (claim.type === 'file_delete') {
          return name.includes('delete') || name.includes('remove') || name.includes('unlink') || name.includes('bash');
        }
        if (claim.type === 'bash_exec') {
          return name.includes('bash') || name.includes('exec') || name.includes('command') || name.includes('shell');
        }
        return name.length > 0;
      });

      if (matchingExecs.length === 0) {
        unsupportedClaims.push({
          type: claim.type,
          targetPath: claim.targetPath,
          reason: `No successful ${claim.type} tool execution recorded in turn.`,
        });
      } else if (claim.targetPath) {
        // Precise Path Matching: Check if any matching tool execution operated on the claimed target path
        const pathMatched = matchingExecs.some(exec => {
          const toolPath = this.extractToolPath(exec);
          if (!toolPath) return true; // If tool didn't specify path, pass match
          const claimedNorm = claim.targetPath!.toLowerCase().trim().replace(/^[./\\]+/, '');
          const toolNorm = toolPath.toLowerCase().trim().replace(/^[./\\]+/, '');
          const claimedBase = claimedNorm.split(/[/\\]/).pop()!;
          const toolBase = toolNorm.split(/[/\\]/).pop()!;
          
          // If paths contain directory components, require path inclusion/suffix match rather than sole basename match
          if (claimedNorm.includes('/') || claimedNorm.includes('\\')) {
            return toolNorm.endsWith(claimedNorm) || claimedNorm.endsWith(toolNorm) || toolNorm.includes(claimedNorm);
          }
          return claimedBase === toolBase;
        });

        if (!pathMatched) {
          unsupportedClaims.push({
            type: claim.type,
            targetPath: claim.targetPath,
            reason: `Claimed path '${claim.targetPath}' does not match actual tool argument paths.`,
          });
        }
      }
    }

    const passed = unsupportedClaims.length === 0;
    let annotatedText = response;

    if (!passed) {
      const details = unsupportedClaims.map(u => u.targetPath ? `${u.type}(${u.targetPath})` : u.type).join(', ');
      annotatedText += `\n\n[SIDE-EFFECT GUARD WARNING: Response claimed empirical side-effects [${details}] that lack verified tool backing.]`;
    }

    return {
      passed,
      claimsDetected,
      unsupportedClaims,
      annotatedText,
    };
  }
}

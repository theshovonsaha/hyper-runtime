/**
 * core/evidence_lane.ts — Evidence Priority Lane (Production Grade)
 *
 * Implements deterministic priority scoring for tool results:
 * (failure_penalty, administrative_penalty, exact_match_bonus, tool_kind_priority)
 *
 * Performs deep target extraction (file paths, URLs, code symbols, environment keys)
 * and matches exact target paths against structured tool inputs and outputs.
 */

import { createHash } from 'crypto';

export interface EvidenceItem {
  id: string;
  toolName: string;
  content: string;
  isFailure: boolean;
  isExactTarget: boolean;
  score: number; // lower score = higher priority
}

export class EvidencePriorityLane {
  private urlRegex = /(?:https?:\/\/)?(?:[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?(?:\/[^\s"']*)?/gi;
  private filePathRegex = /(?:\/|[a-zA-Z]:\\|\.\/|\.\.\/)[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+/gi;
  private codeSymbolRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\(\)/g;

  /**
   * Tool Kind Priority mapping (ascending order: lower = higher priority)
   */
  private toolKindPriority(toolName: string): number {
    const name = toolName.toLowerCase();
    if (name.includes('web_fetch') || name.includes('fetch')) return 0;
    if (name.includes('file_view') || name.includes('read_file') || name.includes('view')) return 1;
    if (name.includes('web_search') || name.includes('search')) return 2;
    if (name.includes('image_search')) return 3;
    if (name.includes('query_memory') || name.includes('memory_get')) return 5;
    if (name.includes('todo_update')) return 6;
    if (name.includes('todo_write')) return 7;
    if (name.includes('store_memory')) return 8;
    return 4; // default tool kind
  }

  /**
   * Extract deep targets (URLs, file paths, code symbols) from prompt
   */
  extractDeepTargets(userPrompt: string): { urls: string[]; paths: string[]; symbols: string[] } {
    const urls = Array.from(new Set((userPrompt.match(this.urlRegex) || []).map(u => u.toLowerCase())));
    const paths = Array.from(new Set((userPrompt.match(this.filePathRegex) || []).map(p => p.toLowerCase())));
    const symbols = Array.from(new Set((userPrompt.match(this.codeSymbolRegex) || []).map(s => s.toLowerCase())));
    return { urls, paths, symbols };
  }

  /**
   * Calculates evidence priority score tuple.
   * Lower rank = higher priority.
   */
  scoreItem(
    toolName: string,
    content: string,
    isFailure: boolean,
    targets: { urls: string[]; paths: string[]; symbols: string[] }
  ): { isExactTarget: boolean; score: number } {
    const lowerContent = content.toLowerCase();
    const lowerName = toolName.toLowerCase();

    const matchesUrl = targets.urls.some(u => lowerContent.includes(u) || lowerName.includes(u));
    const matchesPath = targets.paths.some(p => {
      const base = p.split(/[/\\]/).pop()!;
      return lowerContent.includes(p) || lowerContent.includes(base);
    });
    const matchesSymbol = targets.symbols.some(s => lowerContent.includes(s));

    const isExactTarget = matchesUrl || matchesPath || matchesSymbol;

    const failurePenalty = isFailure ? 10 : 0;
    const isAdmin = ['todo_update', 'todo_write', 'store_memory'].some(k => lowerName.includes(k));
    const adminPenalty = isAdmin ? 20 : 0;
    const exactBonus = isExactTarget ? -50 : 0;
    const kindPriority = this.toolKindPriority(toolName);

    const score = exactBonus + failurePenalty + adminPenalty + kindPriority;
    return { isExactTarget, score };
  }

  /**
   * Processes raw tool outputs into a deduplicated, ranked working evidence set (default k = 4).
   */
  processToolResults(
    results: Array<{ id?: string; toolName: string; content: string; isFailure?: boolean }>,
    userPrompt: string,
    k: number = 4
  ): EvidenceItem[] {
    const targets = this.extractDeepTargets(userPrompt);
    const seenHashes = new Set<string>();
    const items: EvidenceItem[] = [];

    for (const r of results) {
      const normalizedContent = r.content.trim().replace(/\s+/g, ' ');
      const hash = createHash('sha256').update(`${r.toolName.toLowerCase()}:${normalizedContent}`).digest('hex');
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      const isFailure = r.isFailure ?? false;
      const { isExactTarget, score } = this.scoreItem(r.toolName, r.content, isFailure, targets);

      items.push({
        id: r.id || 'ev_' + crypto.randomUUID().slice(0, 8),
        toolName: r.toolName,
        content: r.content,
        isFailure,
        isExactTarget,
        score,
      });
    }

    // Sort ascending by score (lowest score = highest priority)
    items.sort((a, b) => a.score - b.score);

    let selected = items.slice(0, k);

    // Failure Injection Rule: If selected set < k and contains at least 1 success, inject most recent failure
    if (selected.length < k) {
      const unselectedFailures = items.filter(i => i.isFailure && !selected.includes(i));
      if (unselectedFailures.length > 0) {
        selected.push(unselectedFailures[0]);
      }
    }

    return selected;
  }
}

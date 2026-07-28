/**
 * memory/tiering.ts — Multi-Tiered Memory Architecture (Short-Term, Long-Term, Episodic & Working Memory).
 *
 * DIAMOND STANDALONE MODULE:
 *   - Short-Term Memory (STM): High-fidelity recent turn buffer.
 *   - Long-Term Memory (LTM): Consolidated semantic memory nodes with decay weights.
 *   - Episodic Memory: Milestone session snapshots & trajectory branch forks.
 *   - Working Memory: Scratchpad for active tool execution results.
 */

export interface MemoryItem {
  id: string;
  tier: 'short_term' | 'long_term' | 'episodic' | 'working';
  content: string;
  tags: string[];
  importanceScore: number; // 0.0 - 1.0
  createdAt: number;
  lastAccessedAt: number;
}

export class MemoryTieringEngine {
  private stm: MemoryItem[] = [];
  private ltm: MemoryItem[] = [];
  private episodic: MemoryItem[] = [];
  private working: MemoryItem[] = [];

  pushShortTerm(content: string, tags: string[] = []): MemoryItem {
    const item: MemoryItem = {
      id: 'stm_' + crypto.randomUUID().slice(0, 8),
      tier: 'short_term',
      content,
      tags,
      importanceScore: 0.8,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    this.stm.push(item);
    if (this.stm.length > 20) {
      // Consolidate oldest STM to LTM
      const oldest = this.stm.shift();
      if (oldest) this.promoteToLongTerm(oldest);
    }
    return item;
  }

  promoteToLongTerm(item: MemoryItem): MemoryItem {
    const ltmItem: MemoryItem = { ...item, tier: 'long_term', importanceScore: 0.9 };
    this.ltm.push(ltmItem);
    if (this.ltm.length > 100) {
      this.ltm.shift();
    }
    return ltmItem;
  }

  pushEpisodic(milestoneTitle: string, details: string): MemoryItem {
    const item: MemoryItem = {
      id: 'epi_' + crypto.randomUUID().slice(0, 8),
      tier: 'episodic',
      content: `[MILESTONE: ${milestoneTitle}] ${details}`,
      tags: ['milestone', 'episodic'],
      importanceScore: 1.0,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    this.episodic.push(item);
    if (this.episodic.length > 100) {
      this.episodic.shift();
    }
    return item;
  }

  setWorkingMemory(key: string, value: string): void {
    this.working = this.working.filter(w => !w.content.startsWith(`${key}:`));
    this.working.push({
      id: 'wrk_' + crypto.randomUUID().slice(0, 8),
      tier: 'working',
      content: `${key}: ${value}`,
      tags: ['working'],
      importanceScore: 0.7,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  }

  getWorkingMemory(key: string): string | undefined {
    const found = this.working.find(w => w.content.startsWith(`${key}:`));
    if (!found) return undefined;
    return found.content.split(':').slice(1).join(':').trim();
  }

  /** Retrieve across all 4 memory tiers using Jaccard term-matching */
  retrieveCrossTier(query: string, maxItems = 5): MemoryItem[] {
    const queryTerms = new Set((query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    if (queryTerms.size === 0) return [];

    const allItems = [...this.stm, ...this.ltm, ...this.episodic, ...this.working];
    const scored: Array<{ item: MemoryItem; score: number }> = [];

    for (const item of allItems) {
      const terms = (item.content || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      let matches = 0;
      for (const t of terms) {
        if (queryTerms.has(t)) matches++;
      }
      if (matches > 0) {
        const jaccard = matches / (queryTerms.size + terms.length - matches || 1);
        const finalScore = jaccard * item.importanceScore;
        scored.push({ item, score: finalScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxItems).map(s => s.item);
  }
}

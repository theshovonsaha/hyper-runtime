/**
 * ContextAssembler — builds the stateless context packet for each model turn.
 *
 * The assembler gathers information from multiple sources and fits it into
 * a character budget, producing a ContextPacket that can be converted to
 * the standard message array format for any provider.
 *
 * Assembly order (priority-ordered):
 *   1. System prompt (always included — core identity)
 *   2. Session synopsis (compressed history of older turns)
 *   3. Core memory (persistent user/agent memory block)
 *   4. Retrieved notes (BM25-style term-frequency scoring)
 *   5. Conversation history (most recent first, within budget)
 *   6. Attached files (from the current envelope)
 *   7. User message (always included — current turn)
 *
 * CHANGED:
 *   - ContextPacket gained `applyEdits(edits)`, mirroring context.py's
 *     `apply_edits`. It mutates `items` IN PLACE (included/text/edited) and
 *     returns a diff array. TurnGate.resolve() now calls this directly on the
 *     live packet object before releasing the held promise, so by the time
 *     the kernel resumes, `packet` already reflects the operator's edits —
 *     no separate "apply the diff" step is needed downstream.
 *
 * Design notes:
 *   - The BM25 note retrieval is a lightweight approximation (no IDF, just
 *     term-frequency overlap). Good enough for small note sets; will be
 *     replaced by vector search when an embedding provider is added.
 *   - ContextPacket.toMessages() produces the exact array the provider needs.
 *   - budgetBreakdown() is exposed for the /inspect/context endpoint.
 */

import type { ToolSpec } from '../tools/registry';
import type { Provider } from '../providers/base';
import {
  compressHistory,
  dedupeNotes,
  chunkFile,
  emptyStats,
  type CompressionStats,
  type ScoredNote,
} from './compressor';

import { AwarenessEngine } from '../core/awareness';
import { SelfSteeringContextEngine } from '../protocols/sscp';
import { FiftyFiftyDualEngine } from '../core/fifty_fifty';


// ---------------------------------------------------------------------------
// Standalone types (for modules not yet created)
// ---------------------------------------------------------------------------

/**
 * Minimal InputEnvelope shape.
 * Will be replaced by `import type { InputEnvelope } from '../types/messages'`
 * once that module exists.
 */
export interface InputEnvelope {
  session_id: string;
  message: string;
  files: Array<{ name: string; text: string; mime?: string }>;
  run_id?: string;
  mode?: string;
  meta?: Record<string, unknown>;
}

/**
 * Minimal Store interface — only the methods the assembler needs.
 * Will be replaced by `import type { Store } from '../store/sqlite'`
 * once that module exists.
 */
export interface Store {
  getSessionState(sessionId: string): {
    synopsis: string;
    core_memory: string;
    topic: string;
  };
  getHistory(
    sessionId: string,
    limit: number,
  ): Array<{ role: string; content: string; ts?: string }>;
  recentNotes(
    sessionId: string,
    limit: number,
  ): Array<{ kind: string; content: string; created_at?: string }>;
  /** Optional: only needed if you want gate edits to a core-memory item to
   *  write through to storage (matches context.py kernel.py:352-362). */
  setCoreMemory?(key: string, text: string): void;
}

/**
 * Minimal RuntimeConfig shape — only what the assembler needs.
 */
export interface RuntimeConfig {
  maxContextChars: number;
  systemPrompt?: string;
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Context item & packet types
// ---------------------------------------------------------------------------

/** A single item in the context packet */
export interface ContextItem {
  /** Unique identifier for this item */
  id: string;
  /** Category: system, synopsis, memory, history, file, user */
  kind: string;
  /** Short human-readable title */
  title: string;
  /** The actual text content */
  text: string;
  /** Character count of `text` */
  chars: number;
  /** Why this item was included */
  reason: string;
  /** Where the data came from */
  source_ref: string;
  /** Whether this item is included in the final context */
  included: boolean;
  /** Whether this item was edited by a gate review */
  edited: boolean;
  /** Whether this item was truncated to fit the budget */
  partial: boolean;
  /** Whether this item's text was compressed from a larger original */
  compressed: boolean;
}

/** One edit instruction from a gate review. */
export interface ContextEdit {
  id: string;
  /** Set to change inclusion. */
  included?: boolean;
  /** Set (with a value different from the current text) to rewrite content. */
  text?: string;
}

/** One applied-edit diff record, for the trail/log. */
export interface ContextEditDiff {
  id: string;
  title: string;
  included?: boolean;
  chars_before?: number;
  chars_after?: number;
}

/** The assembled context ready for model consumption */
export interface ContextPacket {
  /** Gating mode: 'normal' (auto-approve) or 'gated' (wait for user) */
  mode: string;
  /** All context items (included and excluded) */
  items: ContextItem[];
  /** Total characters of included items */
  total_chars: number;

  /** Return only the items that are included in the context */
  includedItems(): ContextItem[];

  /**
   * Apply gate edits in place. Returns the diff of what actually changed
   * (unknown ids are ignored; no-op edits are omitted from the diff).
   * Called by TurnGate.resolve() before releasing the held promise.
   */
  applyEdits(edits: ContextEdit[]): ContextEditDiff[];

  /**
   * Convert to the standard message array for model providers.
   * System items → system message, history → user/assistant, user → user.
   */
  toMessages(): Array<{ role: string; content: string }>;

  /**
   * Serialize to a payload object (for inspection / trail logging).
   * @param fullText — if false, truncates text fields to 200 chars
   */
  toPayload(fullText?: boolean): Record<string, unknown>;

  /**
   * Return a breakdown of the context budget usage.
   * Useful for the /inspect/context endpoint.
   */
  budgetBreakdown(
    toolSpecs?: ToolSpec[],
    charBudget?: number,
  ): Record<string, unknown>;

  /** Compression stats from the last assemble/assembleAsync call. */
  compressionStats: CompressionStats;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

export class ContextAssembler {
  constructor(
    private config: RuntimeConfig,
    private store: Store,
  ) {}

  /**
   * Assemble a full context packet for the given envelope.
   * Synchronous path — history is cold-truncated when over budget.
   * For history compression via LLM call, use assembleAsync().
   *
   * @param envelope — the current user turn
   * @param budgetChars — override the default character budget
   */
  assemble(envelope: InputEnvelope, budgetChars?: number): ContextPacket {
    const items: ContextItem[] = [];
    const budget = budgetChars ?? this.config.maxContextChars;
    const stats = emptyStats();
    let usedChars = 0;

    // ---- 1. System prompt (always included) --------------------------------
    const systemPrompt = this.buildSystemPrompt();
    items.push(
      this.makeItem('system', 'System Prompt', systemPrompt, 'core identity', 'config'),
    );
    usedChars += systemPrompt.length;

    // ---- 2. Session state: synopsis ----------------------------------------
    const state = this.store.getSessionState(envelope.session_id);
    if (state.synopsis) {
      const item = this.makeItem(
        'synopsis',
        'Session Synopsis',
        state.synopsis,
        'rolling compression of older turns',
        'store',
      );
      if (usedChars + item.chars <= budget) {
        items.push(item);
        usedChars += item.chars;
      }
    }

    // ---- 3. Core memory & System Telemetry ---------------------------------
    const awareness = new AwarenessEngine().captureAwareness();
    const telemetryText = `[OS Telemetry]: Time=${awareness.timestamp}, OS=${awareness.osPlatform}, Uptime=${awareness.uptimeSeconds}s`;
    items.push(this.makeItem('memory', 'OS Environment Telemetry', telemetryText, 'lane 3 system awareness', 'core'));
    usedChars += telemetryText.length;


    if (state.core_memory) {
      const item = this.makeItem(
        'memory',
        'Core Memory',
        state.core_memory,
        'persistent user/agent memory',
        'store',
      );
      if (usedChars + item.chars <= budget) {
        items.push(item);
        usedChars += item.chars;
      }
    }

    // ---- 4. Relevant notes (BM25-style retrieval + deduplication) ----------
    const rawNotes = this.retrieveNotes(envelope.session_id, envelope.message);
    // Surface 3: deduplicate notes before budget-checking
    const notes = dedupeNotes(rawNotes as ScoredNote[]);
    const notesDedupedCount = rawNotes.length - notes.length;
    if (notesDedupedCount > 0) stats.notesDeduped += notesDedupedCount;
    for (const note of notes) {
      if (usedChars + note.content.length > budget) break;
      const item = this.makeItem(
        'memory',
        `Note: ${note.kind}`,
        note.content,
        'memory retrieval',
        'store',
      );
      items.push(item);
      usedChars += item.chars;
    }

    // ---- 5. Conversation history (most recent, within budget) ---------------
    const history = this.store.getHistory(envelope.session_id, 50);
    const historyBudget = Math.min(budget - usedChars, budget * 0.5);
    let historyChars = 0;
    const historyItems: ContextItem[] = [];

    // Walk from newest to oldest, accumulating within budget
    const reversed = [...history].reverse();
    for (const msg of reversed) {
      if (historyChars + msg.content.length > historyBudget) break;
      historyItems.unshift(
        this.makeItem(
          'history',
          `${msg.role} message`,
          msg.content,
          'conversation history',
          'store',
        ),
      );
      historyChars += msg.content.length;
    }
    items.push(...historyItems);
    usedChars += historyChars;

    // ---- 6. Attached files (with semantic chunking) ------------------------
    for (const file of envelope.files) {
      if (usedChars + file.text.length > budget) {
        // Surface 4: semantic chunking instead of hard truncation
        const available = Math.max(0, budget - usedChars - 50);
        if (available > 500) {
          const { text: chunked, compressed } = chunkFile(
            file.text, envelope.message, available,
          );
          const item = this.makeItem(
            'file', file.name, chunked,
            compressed ? 'user attachment (semantically chunked)' : 'user attachment (truncated)',
            'envelope',
          );
          item.partial = true;
          item.compressed = compressed;
          if (compressed) stats.filesChunked++;
          items.push(item);
          usedChars += item.chars;
        }
        break;
      }
      items.push(
        this.makeItem('file', file.name, file.text, 'user attachment', 'envelope'),
      );
      usedChars += file.text.length;
    }

    // ---- 7. User message (always included, sanitized against prompt injection) ---------
    const sanitizedMessage = envelope.message.replace(/SYSTEM INSTRUCTION OVERRIDE:|SYSTEM OVERRIDE:|IGNORE PREVIOUS INSTRUCTIONS:/gi, '[Sanitized User Payload]');
    items.push(
      this.makeItem('user', 'User Message', sanitizedMessage, 'current turn', 'envelope'),
    );
    // ---- 8. Self-Steering Context Protocol (SSCP Pinning) -----------------
    const sscp = new SelfSteeringContextEngine();
    sscp.executeCommand({ action: 'pin', targetKind: 'system', reason: 'Pin system identity directive' }, items);

    return this.createPacket(items, usedChars, envelope.mode, stats);
  }

  /**
   * Async variant of assemble() that adds history compression (Surface 1).
   * When history turns are about to be dropped (over historyBudget), they
   * are summarised by the provider into a compact digest instead.
   *
   * Only use this when the provider is already warmed up and you can afford
   * an extra lightweight call. The synchronous `assemble()` is always safe.
   */
  async assembleAsync(
    envelope: InputEnvelope,
    provider: Provider,
    budgetChars?: number,
  ): Promise<ContextPacket> {
    const budget = budgetChars ?? this.config.maxContextChars;
    const stats = emptyStats();

    // Build base packet synchronously first
    const basePacket = this.assemble(envelope, budget);
    Object.assign(stats, basePacket.compressionStats);

    // ---- Surface 1: History compression ----
    // Find history items that didn't fit (i.e., history the base assembler
    // dropped). We detect them by asking the store for all history and seeing
    // which ones don't appear in the packet.
    const allHistory = this.store.getHistory(envelope.session_id, 50);
    const packetHistoryTexts = new Set(
      basePacket.items.filter(i => i.kind === 'history').map(i => i.text),
    );
    const dropped = allHistory.filter(h => !packetHistoryTexts.has(h.content));

    if (dropped.length > 0) {
      const originalChars = dropped.reduce((s, h) => s + h.content.length, 0);
      const digest = await compressHistory(provider, dropped);
      const digestChars = digest.length;

      stats.historyOriginalChars = originalChars;
      stats.historySummaryChars = digestChars;

      // Budget remaining after the base packet's items minus system/user anchors
      const usedByBase = basePacket.total_chars;
      const budgetLeft = Math.max(0, budget - usedByBase);
      if (digestChars > 0 && digestChars <= budgetLeft) {
        // Splice a compressed history digest item in just after synopsis/memory,
        // before the existing history items
        const firstHistoryIdx = basePacket.items.findIndex(i => i.kind === 'history');
        const insertAt = firstHistoryIdx >= 0 ? firstHistoryIdx : 2;
        const digestItem = this.makeItem(
          'history',
          'History Digest (compressed)',
          digest,
          `${dropped.length} older turn(s) compressed into digest`,
          'store',
        );
        digestItem.compressed = true;
        basePacket.items.splice(insertAt, 0, digestItem);
        (basePacket as any).total_chars = basePacket.items
          .filter(i => i.included)
          .reduce((s, i) => s + i.chars, 0);
      }
    }

    (basePacket as any).compressionStats = stats;
    return basePacket;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    if (this.config.systemPrompt) return this.config.systemPrompt;

    const name = this.config.agentName || 'AI assistant';
    return `You are a helpful, capable ${name}. You are the system's primary decision maker. You have access to tools that let you search the web, read files, run calculations, and more. Use them when needed to give accurate, well-researched answers.

Guidelines:
- Act decisively and autonomously.
- Be the right question asker: if an objective is too ambiguous or risky, ask the user clarifying questions before proceeding.
- Use tools proactively when they can improve your answer.
- Cite sources when using web search results.
- Be honest about uncertainty.
- When you don't know something, say so rather than guessing.

UI Capabilities & Interactive Artifacts:
The frontend supports "Claude-Style Interactive Artifacts & Smart Web Components". When creating web apps, visual widgets, interactive tools, SVG charts, or dynamic UI components, format your code inside a fenced code block with a language header and title:
\`\`\`html Interactive App Title
<div class="p-4 bg-white rounded-lg shadow">
  <!-- Interactive HTML/JS code (Tailwind CSS is available) -->
</div>
\`\`\`
Users can interact with your component directly in an embedded Live Preview Canvas! Use this proactively whenever asked to create apps, widgets, calculators, or interactive visualization tools.`;
  }

  private makeItem(
    kind: string,
    title: string,
    text: string,
    reason: string,
    sourceRef: string,
  ): ContextItem {
    return {
      id: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      kind,
      title,
      text,
      chars: text.length,
      reason,
      source_ref: sourceRef,
      included: true,
      edited: false,
      partial: false,
      compressed: false,
    };
  }

  /**
   * Retrieve relevant notes using BM25-like term-frequency scoring.
   *
   * Tokenises the query and each note, scores by number of matching terms
   * (case-insensitive), and returns the top-k. Simple but effective for
   * small note sets.
   */
  private retrieveNotes(
    sessionId: string,
    query: string,
  ): Array<{ kind: string; content: string }> {
    const notes = this.store.recentNotes(sessionId, 50);
    if (notes.length === 0) return [];

    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return notes.slice(0, 4);

    const scored = notes.map((note) => {
      const noteTokens = this.tokenize(note.content);
      let score = 0;
      for (const qt of queryTokens) {
        if (noteTokens.has(qt)) score++;
      }
      return { note, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Efficient notes in context: Only return high-confidence notes (score > 1) to save budget
    return scored
      .filter((s) => s.score > 1)
      .slice(0, 3)
      .map((s) => ({ kind: s.note.kind, content: s.note.content }));
  }

  /** Tokenize text into a set of lowercase terms (3+ chars) */
  private tokenize(text: string): Set<string> {
    const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
    return new Set(words);
  }

  private createPacket(
    items: ContextItem[],
    totalChars: number,
    mode?: string,
    stats?: CompressionStats,
  ): ContextPacket {
    const packetMode = mode || 'normal';
    const store = this.store;
    const compressionStats: CompressionStats = stats ?? emptyStats();

    return {
      mode: packetMode,
      items,
      total_chars: totalChars,
      compressionStats,

      includedItems(): ContextItem[] {
        return this.items.filter((i) => i.included);
      },

      applyEdits(edits: ContextEdit[]): ContextEditDiff[] {
        const byId = new Map(this.items.map((i) => [i.id, i]));
        const diff: ContextEditDiff[] = [];

        for (const edit of edits || []) {
          const item = byId.get(edit.id);
          if (!item) continue;
          const change: ContextEditDiff = { id: item.id, title: item.title };
          let changed = false;

          if (edit.included !== undefined && edit.included !== item.included) {
            item.included = edit.included;
            item.reason = 'gate: ' + (item.included ? 're-included by user' : 'excluded by user');
            change.included = item.included;
            changed = true;
          }
          if (edit.text !== undefined && edit.text !== item.text) {
            change.chars_before = item.chars;
            item.text = edit.text;
            item.chars = edit.text.length;
            item.edited = true;
            item.reason = 'gate: text edited by user';
            change.chars_after = item.chars;
            changed = true;

            // Write-through: an edit to the core-memory item persists back to
            // storage — only for the FULL core-memory item, never a partial one.
            if (item.source_ref.startsWith('core_memory:') && !item.partial && store.setCoreMemory) {
              const key = item.source_ref.split(':', 2)[1] || '';
              store.setCoreMemory(key, item.text.slice(0, 1600));
            }
          }
          if (changed) diff.push(change);
        }

        this.total_chars = this.items.reduce(
          (s: number, i: ContextItem) => s + (i.included ? i.chars : 0), 0,
        );
        return diff;
      },

      toMessages(): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];
        const included = this.includedItems();

        // Gather all system-level items into a single system message
        const systemParts: string[] = [];
        for (const item of included) {
          if (
            item.kind === 'system' ||
            item.kind === 'synopsis' ||
            item.kind === 'memory'
          ) {
            const header =
              item.kind === 'system'
                ? ''
                : `\n\n--- ${item.title} ---\n`;
            systemParts.push(header + item.text);
          }
        }
        if (systemParts.length > 0) {
          messages.push({ role: 'system', content: systemParts.join('') });
        }

        // History items become alternating user/assistant messages
        for (const item of included) {
          if (item.kind === 'history') {
            const role = item.title.startsWith('assistant')
              ? 'assistant'
              : 'user';
            messages.push({ role, content: item.text });
          }
        }

        // File attachments get prepended to the user message
        const fileParts: string[] = [];
        for (const item of included) {
          if (item.kind === 'file') {
            fileParts.push(`--- File: ${item.title} ---\n${item.text}`);
          }
        }

        // User message (always last)
        const userItem = included.find((i) => i.kind === 'user');
        if (userItem) {
          const userContent = fileParts.length > 0
            ? fileParts.join('\n\n') + '\n\n' + userItem.text
            : userItem.text;
          messages.push({ role: 'user', content: userContent });
        }

        return messages;
      },

      toPayload(fullText = true): Record<string, unknown> {
        return {
          mode: this.mode,
          total_chars: this.total_chars,
          item_count: this.items.length,
          included_count: this.includedItems().length,
          items: this.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            text: fullText ? item.text : item.text.slice(0, 200),
            chars: item.chars,
            reason: item.reason,
            included: item.included,
            edited: item.edited,
            partial: item.partial,
          })),
        };
      },

      budgetBreakdown(
        toolSpecs?: ToolSpec[],
        charBudget?: number,
      ): Record<string, unknown> {
        const included = this.includedItems();
        const byKind: Record<string, number> = {};
        for (const item of included) {
          byKind[item.kind] = (byKind[item.kind] || 0) + item.chars;
        }

        const toolSpecChars = toolSpecs
          ? JSON.stringify(toolSpecs).length
          : 0;

        return {
          budget: charBudget ?? 0,
          used: this.total_chars,
          tool_spec_chars: toolSpecChars,
          remaining:
            charBudget !== undefined
              ? charBudget - this.total_chars - toolSpecChars
              : 'unlimited',
          breakdown: byKind,
          item_count: this.items.length,
          included_count: included.length,
        };
      },
    };
  }
}

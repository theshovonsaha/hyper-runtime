/**
 * context/compressor.ts — Information compression for the context budget.
 *
 * Four compression surfaces, each triggered by a budget threshold:
 *
 *  1. History compression   — when the history window is too long, the oldest
 *                             messages are summarised into a "rolling digest"
 *                             instead of being silently dropped. The digest
 *                             replaces them in the packet so the model still
 *                             sees what happened, just more densely.
 *
 *  2. Tool-result extraction — long tool payloads (JSON, HTML, file contents)
 *                             are filtered down to salient lines/keys before
 *                             they're appended to the transcript, so each step
 *                             doesn't bloat the context by 10 k chars of raw
 *                             output the model doesn't need in full.
 *
 *  3. Note deduplication    — when the BM25 scorer returns notes that overlap
 *                             heavily with each other (≥ TOKEN_OVERLAP_THRESHOLD
 *                             word overlap), the lower-scoring duplicate is
 *                             dropped rather than consuming budget for near-
 *                             identical facts.
 *
 *  4. File semantic chunking — large file attachments are sliced into
 *                              fixed-size chunks and only the chunks whose
 *                              term-overlap with the user's query clears the
 *                              relevance bar are kept. The first chunk is
 *                              always kept so context / imports are preserved.
 *
 * All four surfaces are fail-safe: if the provider call fails (history summary,
 * result extraction), the original text is returned unchanged so the compressor
 * never blocks a turn.
 *
 * Integration points (no changes needed outside this file and assembler.ts):
 *   assembler.ts — import and call compressHistory / dedupeNotes / chunkFile
 *   loop.ts      — import and call extractToolResult before pushToolResult()
 */

import type { Provider } from '../providers/base';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A tool result larger than this (chars) gets extraction-compressed. */
export const TOOL_RESULT_COMPRESS_THRESHOLD = 1200;

/** A file item larger than this (chars) gets semantic chunking. */
export const FILE_COMPRESS_THRESHOLD = 4000;

/** Chunk size for file semantic chunking. */
export const FILE_CHUNK_SIZE = 1500;

/** Word-overlap ratio above which two notes are considered duplicates. */
export const NOTE_OVERLAP_THRESHOLD = 0.65;

/** Target character length for a history-window summary. */
export const HISTORY_SUMMARY_TARGET_CHARS = 400;

// ---------------------------------------------------------------------------
// Utility: tokenise text into word set (mirrors assembler's tokenize)
// ---------------------------------------------------------------------------

function tokenSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\b\w{3,}\b/g) ?? []));
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const union = new Set([...a, ...b]);
  const inter = [...a].filter(t => b.has(t));
  return inter.length / union.size;
}

// ---------------------------------------------------------------------------
// Surface 1 — History compression
// ---------------------------------------------------------------------------

const HISTORY_COMPRESS_PROMPT = `You are summarising a slice of conversation history for an agent runtime.
Produce ONE compact paragraph (≤ ${HISTORY_SUMMARY_TARGET_CHARS} chars) that preserves:
- Key decisions, tool calls, and their outcomes
- Any facts the agent discovered
- The overall direction of the conversation at that point
Omit greetings, acknowledgements, and filler. Plain prose, no bullet points.`;

export interface HistoryTurn {
  role: string;
  content: string;
}

/**
 * Compress a window of history turns into a short digest.
 * Returns the compressed string, or the concatenation of the original turns
 * on failure (so the caller can still decide what to do with too-long history).
 */
export async function compressHistory(
  provider: Provider,
  turns: HistoryTurn[],
): Promise<string> {
  if (turns.length === 0) return '';

  const block = turns
    .map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 600)}`)
    .join('\n\n');

  // If it's already short enough, just concatenate
  if (block.length <= HISTORY_SUMMARY_TARGET_CHARS * 2) {
    return block;
  }

  try {
    const turn = await provider.streamTurn(
      [
        { role: 'system', content: HISTORY_COMPRESS_PROMPT },
        { role: 'user', content: `Conversation to summarise:\n\n${block}` },
      ],
      [],
      async () => {},
    );
    const summary = (turn.text ?? '').trim();
    return summary || block;
  } catch {
    // Fail-safe: return the original block
    return block;
  }
}

// ---------------------------------------------------------------------------
// Surface 2 — Tool-result extraction
// ---------------------------------------------------------------------------

/**
 * Salient-line extraction — no LLM call. Fast, deterministic.
 *
 * Strategy (in order of data shape detected):
 *   JSON object  → keep top-level string fields ≤ 300 chars + first array item
 *   JSON array   → keep first 5 items, stringify each ≤ 200 chars
 *   Plain text   → score lines by query-term overlap, keep top-N within budget
 *
 * If the result is already under TOOL_RESULT_COMPRESS_THRESHOLD, returns it
 * unchanged.
 */
export function extractToolResult(
  rawResult: string,
  query: string,
  budgetChars = TOOL_RESULT_COMPRESS_THRESHOLD,
): string {
  if (rawResult.length <= budgetChars) return rawResult;

  const trimmed = rawResult.trim();

  // ---- JSON path ----
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const items = parsed.slice(0, 5).map(
          item => JSON.stringify(item).slice(0, 200),
        );
        const head = `[${items.join(', ')}${parsed.length > 5 ? `, … (${parsed.length - 5} more)` : ''}]`;
        return head.length <= budgetChars ? head : head.slice(0, budgetChars) + '…';
      }

      if (typeof parsed === 'object' && parsed !== null) {
        const parts: string[] = [];
        let chars = 0;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            const line = `${k}: ${String(v).slice(0, 300)}`;
            if (chars + line.length > budgetChars) break;
            parts.push(line);
            chars += line.length + 1;
          } else if (Array.isArray(v) && v.length > 0) {
            const line = `${k}: [${JSON.stringify(v[0]).slice(0, 100)}${v.length > 1 ? `, … +${v.length - 1}` : ''}]`;
            if (chars + line.length > budgetChars) break;
            parts.push(line);
            chars += line.length + 1;
          }
        }
        return parts.length > 0 ? parts.join('\n') : trimmed.slice(0, budgetChars) + '…';
      }
    } catch {
      // Not JSON — fall through to text path
    }
  }

  // ---- Plain-text path: score lines by query-term overlap ----
  const queryTerms = tokenSet(query);
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0);

  if (queryTerms.size === 0 || lines.length === 0) {
    return trimmed.slice(0, budgetChars) + (trimmed.length > budgetChars ? '…' : '');
  }

  const scored = lines.map((line, idx) => {
    const lineTerms = tokenSet(line);
    const overlap = jaccardOverlap(queryTerms, lineTerms);
    // First few lines get a structural bonus (imports, headers, etc.)
    const posBonus = idx < 3 ? 0.2 : 0;
    return { line, score: overlap + posBonus };
  });

  scored.sort((a, b) => b.score - a.score);

  const kept: string[] = [];
  let used = 0;
  for (const { line } of scored) {
    if (used + line.length + 1 > budgetChars) break;
    kept.push(line);
    used += line.length + 1;
  }

  return kept.length > 0 ? kept.join('\n') : trimmed.slice(0, budgetChars) + '…';
}

// ---------------------------------------------------------------------------
// Surface 3 — Note deduplication
// ---------------------------------------------------------------------------

export interface ScoredNote {
  kind: string;
  content: string;
  score?: number;
}

/**
 * Deduplicate a list of scored notes by word-overlap.
 * Keeps the highest-scoring note when two overlap ≥ NOTE_OVERLAP_THRESHOLD.
 * Input notes are assumed to be sorted score-descending (assembler already does this).
 */
export function dedupeNotes(notes: ScoredNote[]): ScoredNote[] {
  const kept: ScoredNote[] = [];
  const keptTokens: Set<string>[] = [];

  for (const note of notes) {
    const noteTokens = tokenSet(note.content);
    const isDuplicate = keptTokens.some(
      existing => jaccardOverlap(noteTokens, existing) >= NOTE_OVERLAP_THRESHOLD,
    );
    if (!isDuplicate) {
      kept.push(note);
      keptTokens.push(noteTokens);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Surface 4 — File semantic chunking
// ---------------------------------------------------------------------------

export interface FileChunk {
  index: number;
  text: string;
  score: number;
}

/**
 * Slice a large file into fixed-size chunks and return only the ones relevant
 * to `query`, always including the first chunk (header / imports context).
 *
 * Returns the concatenated text of kept chunks, with chunk-boundary markers.
 * If the file is under FILE_COMPRESS_THRESHOLD, returns it unchanged.
 */
export function chunkFile(
  fileText: string,
  query: string,
  budgetChars = FILE_COMPRESS_THRESHOLD,
): { text: string; compressed: boolean } {
  if (fileText.length <= budgetChars) {
    return { text: fileText, compressed: false };
  }

  const queryTerms = tokenSet(query);
  const chunks: FileChunk[] = [];

  for (let i = 0; i < fileText.length; i += FILE_CHUNK_SIZE) {
    const text = fileText.slice(i, i + FILE_CHUNK_SIZE);
    const chunkTerms = tokenSet(text);
    const score = queryTerms.size > 0
      ? jaccardOverlap(queryTerms, chunkTerms)
      : 0;
    chunks.push({ index: chunks.length, text, score });
  }

  if (chunks.length === 0) return { text: fileText.slice(0, budgetChars), compressed: true };

  // Always keep chunk 0; sort the rest by relevance
  const head = chunks[0];
  const rest = chunks.slice(1).sort((a, b) => b.score - a.score);

  const kept: FileChunk[] = [head];
  let used = head.text.length;

  for (const chunk of rest) {
    if (used + chunk.text.length + 40 > budgetChars) break;
    kept.push(chunk);
    used += chunk.text.length + 40;
  }

  // Re-sort kept chunks by original index so text reads top-to-bottom
  kept.sort((a, b) => a.index - b.index);

  const totalChunks = chunks.length;
  const keptIndexes = new Set(kept.map(c => c.index));
  const parts = kept.map(c => {
    const skippedBefore = c.index > 0 && !keptIndexes.has(c.index - 1);
    return (skippedBefore ? `\n… [chunk ${c.index + 1}/${totalChunks}] …\n` : '') + c.text;
  });

  return { text: parts.join(''), compressed: true };
}

// ---------------------------------------------------------------------------
// Compression stats (for budgetBreakdown / logging)
// ---------------------------------------------------------------------------

export interface CompressionStats {
  historySummaryChars?: number;
  historyOriginalChars?: number;
  toolResultsCompressed: number;
  notesDeduped: number;
  filesChunked: number;
}

export function emptyStats(): CompressionStats {
  return {
    toolResultsCompressed: 0,
    notesDeduped: 0,
    filesChunked: 0,
  };
}

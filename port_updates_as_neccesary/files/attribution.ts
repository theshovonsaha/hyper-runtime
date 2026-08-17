/**
 * core/attribution.ts — Context Item & Tool Output Attribution Engine.
 * Ported from python attribution.py
 *
 * Quantifies which context items (synopsis, core_memory, notes, files) and
 * tool execution outputs contributed directly to generated response sentences.
 */

interface ContextItem {
  id: string;
  kind: string;
  title: string;
  source_ref: string;
  text?: string;
  included?: boolean;
}

export interface AttributionScore {
  itemId: string;
  kind: string;
  title: string;
  sourceRef: string;
  score: number;            // 0.0 to 1.0 similarity / contribution score
  matchedTokens: string[];
}

export interface RunAttributionReport {
  runId: string;
  totalItemsEvaluated: number;
  attributions: AttributionScore[];
  topContributor?: AttributionScore;
}

/**
 * Tokenize string into lowercase alphanumeric word n-grams.
 */
function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  return new Set(words);
}

/**
 * Calculate Jaccard similarity score between two text sets.
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): { score: number; overlap: string[] } {
  if (setA.size === 0 || setB.size === 0) return { score: 0, overlap: [] };
  const intersection: string[] = [];
  for (const item of setA) {
    if (setB.has(item)) {
      intersection.push(item);
    }
  }
  const unionSize = setA.size + setB.size - intersection.length;
  return {
    score: unionSize === 0 ? 0 : intersection.length / unionSize,
    overlap: intersection,
  };
}

/**
 * Compute attribution report tracing model response text back to context items.
 */
export function computeAttribution(
  runId: string,
  responseText: string,
  contextItems: ContextItem[],
): RunAttributionReport {
  const responseTokens = tokenize(responseText);
  const attributions: AttributionScore[] = [];

  for (const item of contextItems) {
    if (!item.included || !item.text) continue;
    const itemTokens = tokenize(item.text);
    const { score, overlap } = jaccardSimilarity(responseTokens, itemTokens);

    if (score > 0.05) {
      attributions.push({
        itemId: item.id,
        kind: item.kind,
        title: item.title,
        sourceRef: item.source_ref,
        score: Math.round(score * 1000) / 1000,
        matchedTokens: overlap.slice(0, 10),
      });
    }
  }

  attributions.sort((a, b) => b.score - a.score);

  return {
    runId,
    totalItemsEvaluated: contextItems.length,
    attributions,
    topContributor: attributions[0],
  };
}

/**
 * core/bias_less_reasoning.ts — Bias-Less Epistemic Reasoning & Determinism Engine.
 *
 * CHANGED:
 *   - `generateCounterfactuals` previously did no synthesis at all — it
 *     spliced the conclusion into three fixed template strings. It now
 *     takes an optional `provider`; if given, it actually asks the model
 *     for genuine alternative hypotheses. Without a provider, it still
 *     falls back to the old templates, but the return type now flags which
 *     mode produced them (`synthesized` vs `templated`) so a caller can't
 *     mistake one for the other.
 *   - `evaluateEpistemicReasoning`'s "Grounding-to-Bias Ratio" divides a
 *     caller-supplied fact count by a bias-word count that defaults to 1
 *     when zero bias words are found — that magic constant is now named
 *     and documented instead of buried in a ternary, and the interface
 *     makes clear this is a coarse lexical heuristic, not a verified
 *     epistemic audit (the engine doesn't check whether `factsCount` is
 *     actually true, only accepts it as given).
 */

import type { Provider } from '../providers/base';

export interface EpistemicEvaluation {
  rawConclusion: string;
  sanitizedConclusion: string;
  counterfactualHypotheses: string[];
  counterfactualMode: 'synthesized' | 'templated';
  /** Lexical heuristic only — NOT a verified measure of how well-grounded the conclusion is. */
  groundingToBiasRatio: number;
  isBiasLessVerified: boolean;
}

/** When zero bias words are found, treat bias count as this floor rather than 0 (avoids divide-by-zero). */
const MIN_BIAS_COUNT = 1;
const GBR_PASS_THRESHOLD = 2.0;

export class BiasLessReasoningEngine {
  /** Sanitize a small fixed list of sycophancy/subjective-framing phrases. Not exhaustive — a rephrase bypasses it. */
  sanitizeSycophancy(text: string): string {
    return text
      .replace(/\b(you are absolutely right|as an ai assistant|i agree completely|certainly|definitely)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Synthesize alternative hypotheses. With a `provider`, this makes a real
   * model call and asks for genuinely different explanations. Without one,
   * falls back to static templates (previous behavior) — callers should
   * check `mode` on the result rather than assume synthesis happened.
   */
  async generateCounterfactuals(
    conclusion: string,
    provider?: Provider,
  ): Promise<{ hypotheses: string[]; mode: 'synthesized' | 'templated' }> {
    if (provider) {
      try {
        const prompt = `Given this conclusion: "${conclusion}"\n\n` +
          `Produce exactly 3 genuinely different counterfactual hypotheses that could explain the same ` +
          `observation, each under 30 words. Return STRICT JSON: {"hypotheses": ["...", "...", "..."]}`;
        const turn = await provider.streamTurn([{ role: 'user', content: prompt }], [], () => Promise.resolve());
        const cleaned = (turn.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
        const start = cleaned.indexOf('{');
        const stop = cleaned.lastIndexOf('}');
        if (start !== -1 && stop > start) {
          const parsed = JSON.parse(cleaned.slice(start, stop + 1));
          if (Array.isArray(parsed.hypotheses) && parsed.hypotheses.length > 0) {
            return { hypotheses: parsed.hypotheses.slice(0, 3).map(String), mode: 'synthesized' };
          }
        }
      } catch {
        // fall through to templates below — never crash the caller over this
      }
    }
    const snippet = conclusion.slice(0, 30);
    return {
      mode: 'templated',
      hypotheses: [
        `Hypothesis A (Inverse Assumption): What if the primary cause of [${snippet}] is false?`,
        `Hypothesis B (Edge Failure): Under what extreme boundary condition does [${snippet}] fail?`,
        `Hypothesis C (Alternative Model): What alternative explanation accounts for the same data?`,
      ],
    };
  }

  /**
   * Compute a lexical Grounding-to-Bias Ratio. `factsCount` is trusted as
   * given by the caller — this method does not verify facts, it only scores
   * the ratio of asserted facts to detected bias-language markers.
   */
  async evaluateEpistemicReasoning(
    prompt: string,
    conclusion: string,
    factsCount: number,
    provider?: Provider,
  ): Promise<EpistemicEvaluation> {
    const sanitized = this.sanitizeSycophancy(conclusion);
    const biasWordsMatch = conclusion.match(/\b(obviously|clearly|definitely|undoubtedly|always|never)\b/gi) || [];
    const biasCount = biasWordsMatch.length || MIN_BIAS_COUNT;

    const groundingToBiasRatio = parseFloat((factsCount / biasCount).toFixed(2));
    const { hypotheses, mode } = await this.generateCounterfactuals(sanitized, provider);

    return {
      rawConclusion: conclusion,
      sanitizedConclusion: sanitized,
      counterfactualHypotheses: hypotheses,
      counterfactualMode: mode,
      groundingToBiasRatio,
      isBiasLessVerified: groundingToBiasRatio >= GBR_PASS_THRESHOLD && hypotheses.length === 3,
    };
  }
}

/**
 * core/understanding.ts — Multi-Tier System Understanding Layer.
 *
 * Performs pre-inference semantic analysis:
 *   - Semantic intent extraction
 *   - Entity & parameter discovery
 *   - Confidence scoring & missing requirement detection
 *
 * CHANGED: confidenceScore was a hardcoded 0.95 regardless of input, and
 * missingRequirements was declared but never populated — two of the three
 * headline capabilities in this file's own docstring weren't implemented.
 * Both are now derived from the actual signals found (or not found) in the
 * prompt. This is still a lightweight heuristic, not a model call — treat
 * the confidence score as "how much of the prompt matched a known pattern,"
 * not a calibrated probability.
 */

export interface SystemUnderstanding {
  intentCategory: string;
  confidenceScore: number;
  extractedEntities: Record<string, string>;
  missingRequirements: string[];
  recommendedExecutionPath: 'fluid_one_shot' | 'multi_agent_team' | 'scaffolded_verify';
}

export class UnderstandingLayer {
  analyzePrompt(prompt: string): SystemUnderstanding {
    const text = prompt.toLowerCase();
    const entities: Record<string, string> = {};
    const missing: string[] = [];
    let matchedSignals = 0;

    // Extract ticker entities (first match only — a real multi-ticker
    // request like "compare $AAPL and $MSFT" only captures the first one;
    // switch to matchAll if multi-entity extraction matters downstream)
    const tickerMatch = prompt.match(/\$([A-Za-z]{1,5})/);
    if (tickerMatch) {
      entities['ticker'] = tickerMatch[1].toUpperCase();
      matchedSignals++;
    }

    // Extract directory entities
    const dirMatch = prompt.match(/(?:directory|folder|path)\s+([^\s]+)/i);
    if (dirMatch) {
      entities['directory'] = dirMatch[1];
      matchedSignals++;
    }

    let category = 'general';
    let path: 'fluid_one_shot' | 'multi_agent_team' | 'scaffolded_verify' = 'fluid_one_shot';

    const isResearch = /\b(research|search|lookup|find)\b/.test(text);
    const isCode = /\b(code|build|refactor|script|run)\b/.test(text);
    const isTeam = /\b(team|orchestrate|multi-agent)\b/.test(text);
    const isVerify = /\b(verify|audit|security|test)\b/.test(text);

    if (isResearch) { category = 'research'; matchedSignals++; }
    if (isCode) { category = 'code'; matchedSignals++; }
    if (isTeam) { path = 'multi_agent_team'; matchedSignals++; }
    if (isVerify) { path = 'scaffolded_verify'; matchedSignals++; }

    // ---- Missing-requirement detection (was always [] before) ----
    // Category-specific: a research/finance intent that mentions a ticker
    // pattern's *trigger words* ("stock", "quote", "price") but never
    // actually resolved a ticker symbol is a genuine gap the planner should
    // know about before it burns a tool call guessing.
    if (/\b(stock|quote|shares|ticker)\b/.test(text) && !entities['ticker']) {
      missing.push('No ticker symbol found — ask the user which security they mean.');
    }
    if (category === 'code' && !entities['directory'] && /\b(file|repo|project)\b/.test(text)) {
      missing.push('No file/directory path found — ask which location to operate on.');
    }
    if (isTeam && text.trim().split(/\s+/).length < 6) {
      missing.push('Multi-agent orchestration requested but the objective is very short — likely underspecified.');
    }

    // ---- Confidence: fraction of recognized signals, not a fixed constant ----
    // 0 signals matched -> low confidence in the categorization itself;
    // more matched signals -> more confident this is the right bucket.
    // Capped so it never claims false certainty from heuristics alone.
    const confidenceScore = Math.min(0.5 + matchedSignals * 0.15, 0.9);

    return {
      intentCategory: category,
      confidenceScore: Number(confidenceScore.toFixed(2)),
      extractedEntities: entities,
      missingRequirements: missing,
      recommendedExecutionPath: path,
    };
  }
}

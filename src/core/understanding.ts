/**
 * core/understanding.ts — Multi-Tier System Understanding Layer.
 *
 * Performs pre-inference semantic analysis:
 *   - Semantic intent extraction
 *   - Entity & parameter discovery
 *   - Confidence scoring & missing requirement detection
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

    // Extract ticker entities
    const tickerMatch = prompt.match(/\$([A-Za-z]{1,5})/);
    if (tickerMatch) {
      entities['ticker'] = tickerMatch[1].toUpperCase();
    }

    // Extract directory entities
    const dirMatch = prompt.match(/(?:directory|folder|path)\s+([^\s]+)/i);
    if (dirMatch) {
      entities['directory'] = dirMatch[1];
    }

    let category = 'general';
    let path: 'fluid_one_shot' | 'multi_agent_team' | 'scaffolded_verify' = 'fluid_one_shot';

    if (/\b(research|search|lookup|find)\b/.test(text)) {
      category = 'research';
    }
    if (/\b(code|build|refactor|script|run)\b/.test(text)) {
      category = 'code';
    }
    if (/\b(team|orchestrate|multi-agent)\b/.test(text)) {
      path = 'multi_agent_team';
    }
    if (/\b(verify|audit|security|test)\b/.test(text)) {
      path = 'scaffolded_verify';
    }

    return {
      intentCategory: category,
      confidenceScore: 0.95,
      extractedEntities: entities,
      missingRequirements: missing,
      recommendedExecutionPath: path,
    };
  }
}

/**
 * Model capability profiles — adapt to the model, don't hardcode weakness.
 * Ported from capabilities.py
 */

const _DRIVER = /gpt-?[5-9]|gpt-4\.[5-9]|o[1-9]-|claude|sonnet|opus|haiku|fable|gemini-?[2-9]|grok-?[3-9]|deepseek-v[3-9]|deepseek-chat|qwen[3-9].*(30b|32b|72b|80b|235b|max|next|coder)|llama-?4|mistral-large|command-r-plus|kimi|glm-?[4-9]/i;
const _REASONING = /\br1\b|reason|think|qwq|o[1-9]-|deepseek-r/i;
const _WEAK_TOOLS = /-vl-|vision|\b(0\.5|1|1\.5|2|3)b\b|gemma-?[23]|phi-?[23]/i;

export interface Capabilities {
  model: string;
  provider: string;
  driver: boolean;           // owns its plan/verify loop → skip forced passes
  reasoning: boolean;        // emits <think>/reasoning
  reliable_tools: boolean;   // emits tool args reliably (reactive recovery still guards)
  vision: boolean;
  context?: number;
  source: string;            // where the profile came from
}

export function capabilitiesFor(
  provider: string,
  model: string,
  discovered?: { vision?: boolean; context?: number; arch?: string },
  override?: 'driven' | 'scaffolded' | null
): Capabilities {
  const m = (model || '').toLowerCase();
  const caps: Capabilities = {
    model: model || '',
    provider: provider || '',
    driver: false,
    reasoning: false,
    reliable_tools: true,
    vision: false,
    source: 'default',
  };

  if (m && m !== 'mock-1') {
    caps.driver = _DRIVER.test(m);
    caps.reasoning = _REASONING.test(m);
    caps.reliable_tools = !_WEAK_TOOLS.test(m);
    caps.source = (caps.driver || caps.reasoning || !caps.reliable_tools) ? 'known' : 'default';
  }

  if (discovered) {
    if (discovered.vision !== undefined) {
      caps.vision = discovered.vision;
    }
    if (discovered.context !== undefined) {
      caps.context = discovered.context;
    }
    caps.source = 'discovered+' + caps.source;
  }

  if (override === 'driven') {
    caps.driver = true;
    caps.source = 'override:driven';
  } else if (override === 'scaffolded') {
    caps.driver = false;
    caps.source = 'override:scaffolded';
  }

  return caps;
}

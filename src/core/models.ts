import type { RuntimeConfig } from '../types/config';

const CACHE_TTL_MS = 300_000;
const _cache: Record<string, { ts: number; models: any[] }> = {};

const TOOL_FAMILIES = /gpt-[45]|gpt-oss|o[134]-|claude|gemini|llama-?3\.[123]|llama-?4|llama3\.\d|qwen[23]|qwq|mistral-large|mixtral|ministral|command-r|deepseek|kimi|glm-|grok/i;
const VISION_HINTS = /vision|vl|4o|gpt-5|gemini|claude|llava|pixtral|scout|maverick/i;
const EXCLUDE = /whisper|embed|tts|guard|moderation|rerank|clip|audio/i;

function guessCapabilities(id: string) {
  return {
    tools: TOOL_FAMILIES.test(id),
    vision: VISION_HINTS.test(id),
  };
}

export async function listModels(provider: string, config: RuntimeConfig): Promise<any[]> {
  const cached = _cache[provider];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.models;
  }

  let models: any[] = [];
  try {
    if (provider === 'claude' || provider === 'anthropic') {
      models = await fetchAnthropicModels(config.anthropicApiKey);
    } else if (provider === 'gemini') {
      models = await fetchGeminiModels(config.geminiApiKey);
    } else if (provider === 'lmstudio') {
      models = await fetchLmStudioModels(config.lmstudioBaseUrl || 'http://localhost:1234');
    } else if (provider === 'ollama') {
      models = await fetchOpenAICompat(config.ollamaBaseUrl || 'http://localhost:11434/v1', '');
    } else if (provider === 'openai') {
      models = await fetchOpenAICompat('https://api.openai.com/v1', config.openaiApiKey);
    } else if (provider === 'openrouter') {
      models = await fetchOpenAICompat('https://openrouter.ai/api/v1', config.openrouterApiKey);
    } else if (provider === 'groq') {
      models = await fetchOpenAICompat('https://api.groq.com/openai/v1', config.groqApiKey);
    }
  } catch (err) {
    console.error(`Failed to list models for ${provider}:`, err);
  }

  models.sort((a, b) => (a.loaded === b.loaded ? a.id.localeCompare(b.id) : a.loaded ? -1 : 1));
  _cache[provider] = { ts: Date.now(), models };
  return models;
}

async function fetchAnthropicModels(apiKey: string) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((m: any) => ({
    id: m.id,
    tools: true,
    vision: true,
    context: null,
  }));
}

async function fetchGeminiModels(apiKey: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || []).filter((m: any) => !EXCLUDE.test(m.name)).map((m: any) => {
    let id = m.name;
    if (id.startsWith('models/')) id = id.slice(7);
    return {
      id,
      context: m.inputTokenLimit || null,
      ...guessCapabilities(id),
    };
  });
}

async function fetchLmStudioModels(baseUrl: string) {
  const base = baseUrl.replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${base}/api/v1/models`);
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      return models.filter((m: any) => m.type !== 'embedding').map((m: any) => {
        const instances = m.loaded_instances || [];
        const loaded = instances.length > 0;
        const cfg = loaded ? (instances[0].config || {}) : {};
        const caps = m.capabilities || {};
        return {
          id: m.key || '',
          loaded,
          vision: !!caps.vision,
          tools: !!caps.trained_for_tool_use,
          context: cfg.context_length || m.max_context_length,
          arch: m.architecture,
        };
      });
    }
  } catch (e) {}

  // Fallback to v0
  try {
    const res = await fetch(`${base}/api/v0/models`);
    if (res.ok) {
      const data = await res.json();
      const rows = data.data || [];
      return rows.filter((m: any) => m.type !== 'embeddings').map((m: any) => ({
        id: m.id || '',
        loaded: m.state === 'loaded',
        vision: m.type === 'vlm',
        tools: true,
        context: m.max_context_length,
        arch: m.arch,
      }));
    }
  } catch (e) {}
  
  // Fallback to OpenAI compat
  return fetchOpenAICompat(`${base}/v1`, '');
}

async function fetchOpenAICompat(baseUrl: string, apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });
  if (!res.ok) return [];
  const payload = await res.json();
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return rows.map((m: any) => {
    let id = m.id || m.name || '';
    if (id.startsWith('models/')) id = id.slice(7);
    return {
      id,
      context: m.context_length || null,
      ...guessCapabilities(id),
    };
  }).filter((m: any) => m.id && !EXCLUDE.test(m.id));
}

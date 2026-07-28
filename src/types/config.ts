/**
 * types/config.ts — Runtime configuration with environment variable loader.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { InspectionLevel, parseInspectionLevel } from './events';

export interface RuntimeConfig {
  activeModelMapping: any;
  port: number;
  provider: string;
  inspectionLevel: InspectionLevel;
  loopMode: 'adaptive' | 'driven' | 'scaffolded';
  dataDir: string;
  maxSteps: number;
  maxContinuations: number;
  maxAutoSteps: number;
  maxConsecutiveToolFails: number;
  maxContextChars: number;
  maxTranscriptChars: number;
  planPass: boolean;
  verifyPass: boolean;
  memoryExtraction: boolean;
  deltaPass?: boolean;
  gateMode: 'auto' | 'inspect';
  gateTimeoutS: number;
  economyCooldownS: number;
  stagnationOverlapThreshold: number;
  stagnationMaxStrikes: number;
  // Provider API keys
  geminiApiKey: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  openrouterApiKey: string;
  groqApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  lmstudioBaseUrl: string;
  lmstudioModel: string;
  llamacppBaseUrl: string;
  // Search tool keys
  tavilyApiKey: string;
  braveSearchKey: string;
  exaApiKey: string;
  searxngUrl: string;
  searchProvider: string;
  alphaVantageApiKey: string;
  // OTel
  otelEndpoint: string;
  otelHeaders: string;
  // Fallback chain
  fallbackChain: string[];
  subAgentProvider: string;
  subAgentModel: string;
  agentName?: string;
  systemPrompt?: string;
}

/** Load config from Bun.env with sensible defaults */
export function loadConfig(): RuntimeConfig {
  const env = (key: string, fallback = ''): string =>
    (typeof Bun !== 'undefined' ? Bun.env[key] : process.env[key]) ?? fallback;

  const loopRaw = env('SHOVS_V2_LOOP_MODE', 'adaptive');
  const loopMode = (['adaptive', 'driven', 'scaffolded'].includes(loopRaw)
    ? loopRaw
    : 'adaptive') as RuntimeConfig['loopMode'];

  const gateRaw = env('SHOVS_V2_GATE_MODE', 'auto');
  const gateMode = (gateRaw === 'inspect' ? 'inspect' : 'auto') as RuntimeConfig['gateMode'];

  const fallbackRaw = env('SHOVS_PROVIDER_FALLBACK_CHAIN', '');
  const fallbackChain = fallbackRaw
    ? fallbackRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    activeModelMapping: {},
    port: parseInt(env('SHOVS_V2_PORT', '8791'), 10),
    provider: env('SHOVS_V2_PROVIDER', 'gemini'),
    inspectionLevel: parseInspectionLevel(env('SHOVS_V2_INSPECTION_LEVEL', 'NORMAL')),
    loopMode,
    dataDir: env('SHOVS_V2_DATA_DIR', 'data'),
    maxSteps: parseInt(env('SHOVS_V2_MAX_STEPS', '25'), 10),
    maxContinuations: parseInt(env('SHOVS_V2_MAX_CONTINUATIONS', '2'), 10),
    maxAutoSteps: parseInt(env('SHOVS_V2_MAX_AUTO_STEPS', '5'), 10),
    maxConsecutiveToolFails: parseInt(env('SHOVS_V2_MAX_TOOL_FAILS', '3'), 10),
    maxContextChars: parseInt(env('SHOVS_V2_MAX_CONTEXT_CHARS', '120000'), 10),
    maxTranscriptChars: parseInt(env('SHOVS_V2_MAX_TRANSCRIPT_CHARS', '8000'), 10),
    planPass: env('SHOVS_V2_PLAN_PASS', '1') === '1',
    verifyPass: env('SHOVS_V2_VERIFY_PASS', '1') === '1',
    memoryExtraction: env('SHOVS_V2_MEMORY_EXTRACTION', '1') === '1',
    gateMode,
    gateTimeoutS: parseInt(env('SHOVS_V2_GATE_TIMEOUT_S', '300'), 10),
    economyCooldownS: parseInt(env('SHOVS_V2_ECONOMY_COOLDOWN_S', '120'), 10),
    stagnationOverlapThreshold: parseFloat(env('SHOVS_V2_STAGNATION_THRESHOLD', '0.85')),
    stagnationMaxStrikes: parseInt(env('SHOVS_V2_STAGNATION_MAX_STRIKES', '2'), 10),
    // Provider keys
    geminiApiKey: env('GEMINI_API_KEY'),
    anthropicApiKey: env('ANTHROPIC_API_KEY'),
    openaiApiKey: env('OPENAI_API_KEY'),
    openrouterApiKey: env('OPENROUTER_API_KEY'),
    groqApiKey: env('GROQ_API_KEY'),
    ollamaBaseUrl: env('OLLAMA_BASE_URL'),
    ollamaModel: env('OLLAMA_MODEL', 'llama3.1'),
    lmstudioBaseUrl: env('LMSTUDIO_BASE_URL'),
    lmstudioModel: env('LMSTUDIO_MODEL', 'local-model'),
    llamacppBaseUrl: env('LLAMACPP_BASE_URL'),
    // Search
    tavilyApiKey: env('TAVILY_API_KEY'),
    braveSearchKey: env('BRAVE_SEARCH_KEY'),
    exaApiKey: env('EXA_API_KEY'),
    searxngUrl: env('SEARXNG_URL') || env('SEARXNG_BASE_URL'),
    searchProvider: env('SEARCH_PROVIDER'),
    alphaVantageApiKey: env('ALPHA_VANTAGE_API_KEY'),
    // OTel
    otelEndpoint: env('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') || env('OTEL_EXPORTER_OTLP_ENDPOINT'),
    otelHeaders: env('OTEL_EXPORTER_OTLP_HEADERS'),
    // Fallback
    fallbackChain,
    subAgentProvider: env('SHOVS_V2_SUB_AGENT_PROVIDER'),
    subAgentModel: env('SHOVS_V2_SUB_AGENT_MODEL'),
  };
}

/** Ensure all data directories exist */
export function ensureDataDirs(config: RuntimeConfig): void {
  const dirs = [
    config.dataDir,
    join(config.dataDir, 'generated'),
    join(config.dataDir, 'uploads'),
    join(config.dataDir, 'tmp'),
    join(config.dataDir, 'events'),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

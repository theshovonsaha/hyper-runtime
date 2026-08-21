import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { digest, validateGrant } from './shared';

export interface WebSearchArgs extends Record<string, unknown> {
  query: string;
  maxResults?: number;
  topic?: 'general' | 'news' | 'finance';
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

interface WebSearchObservation {
  provider: WebSearchProvider;
  query: string;
  results: WebSearchResult[];
  requestId?: string;
}

export interface WebSearchCapabilityOptions {
  tavilyApiKey?: string;
  endpoint?: string;
  braveApiKey?: string;
  braveEndpoint?: string;
  exaApiKey?: string;
  exaEndpoint?: string;
  searxngBaseUrl?: string;
  providerOrder?: WebSearchProvider[];
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export type WebSearchProvider = 'tavily' | 'brave' | 'exa' | 'searxng';

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

function publicResultUrl(value: unknown): string | undefined {
  const candidate = optionalString(value, 2_000);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedResults(
  value: unknown,
  maximum: number,
  snippetKeys: string[],
  publishedKeys: string[],
): WebSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const url = publicResultUrl(record.url);
    const title = optionalString(record.title, 500);
    if (!url || !title) return [];
    const snippet = snippetKeys.map(key => optionalString(record[key], 4_000)).find(Boolean) ?? '';
    const publishedAt = publishedKeys.map(key => optionalString(record[key], 100)).find(Boolean);
    return [{
      title,
      url,
      snippet,
      ...(typeof record.score === 'number' && Number.isFinite(record.score)
        ? { score: record.score }
        : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }];
  });
}

export class WebSearchCapability implements CapabilityAdapter<WebSearchArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'network.web.search',
    version: '0.2.0',
    description: 'Search the public web through the configured server-side search provider.',
    effects: ['network.request', 'state.read'],
    requiredEffects: ['network.request'],
    targetPatterns: ['search://web'],
    riskCeiling: 3,
    approval: 'risk_based',
    idempotent: true,
    verification: 'required',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
        topic: { type: 'string', enum: ['general', 'news', 'finance'] },
        timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      },
      additionalProperties: false,
    },
  };

  private readonly observations = new Map<string, WebSearchObservation>();
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: WebSearchCapabilityOptions) {
    if (this.providers().length === 0) throw new Error('At least one web search provider is required.');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private providers(): WebSearchProvider[] {
    const available = new Set<WebSearchProvider>();
    if (this.options.tavilyApiKey?.trim()) available.add('tavily');
    if (this.options.braveApiKey?.trim()) available.add('brave');
    if (this.options.exaApiKey?.trim()) available.add('exa');
    if (this.options.searxngBaseUrl?.trim()) available.add('searxng');
    const requested = this.options.providerOrder ?? ['tavily', 'brave', 'exa', 'searxng'];
    return [...new Set([...requested.filter(provider => available.has(provider)), ...available])];
  }

  private async search(
    provider: WebSearchProvider,
    query: string,
    maxResults: number,
    args: WebSearchArgs,
    externalSignal?: AbortSignal,
  ): Promise<WebSearchObservation> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    let input: string;
    let init: RequestInit;
    if (provider === 'tavily') {
      input = this.options.endpoint ?? 'https://api.tavily.com/search';
      init = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.tavilyApiKey!}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          topic: args.topic ?? 'general',
          ...(args.timeRange ? { time_range: args.timeRange } : {}),
        }),
        signal,
      };
    } else if (provider === 'brave') {
      const url = new URL(this.options.braveEndpoint ?? 'https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(maxResults));
      const freshness = ({ day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const)[args.timeRange!];
      if (freshness) url.searchParams.set('freshness', freshness);
      input = url.toString();
      init = {
        method: 'GET',
        headers: { accept: 'application/json', 'x-subscription-token': this.options.braveApiKey! },
        signal,
      };
    } else if (provider === 'exa') {
      input = this.options.exaEndpoint ?? 'https://api.exa.ai/search';
      init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.options.exaApiKey! },
        body: JSON.stringify({
          query,
          numResults: maxResults,
          type: 'auto',
          contents: { text: { maxCharacters: 4_000 } },
        }),
        signal,
      };
    } else {
      const url = new URL('/search', this.options.searxngBaseUrl!.replace(/\/?$/, '/'));
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      if (args.timeRange && args.timeRange !== 'week') url.searchParams.set('time_range', args.timeRange);
      input = url.toString();
      init = { method: 'GET', headers: { accept: 'application/json' }, signal };
    }
    const response = await this.fetchImpl(input, init);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('response exceeds the 1 MB limit');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = JSON.parse(text) as Record<string, unknown>;
    const rawResults = provider === 'brave'
      ? (body.web as Record<string, unknown> | undefined)?.results
      : body.results;
    const results = normalizedResults(
      rawResults,
      maxResults,
      provider === 'brave' ? ['description'] : provider === 'exa' ? ['text', 'highlights'] : ['content'],
      provider === 'exa' ? ['publishedDate'] : ['published_date', 'age'],
    );
    if (results.length === 0) throw new Error('no usable results');
    const requestId = optionalString(body.request_id ?? body.requestId, 300);
    return { provider, query, results, ...(requestId ? { requestId } : {}) };
  }

  async execute(
    proposal: ActionProposal<WebSearchArgs>,
    grant: CapabilityGrant,
    signal?: AbortSignal,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (proposal.target !== 'search://web') {
      return {
        success: false,
        summary: 'Web search must use the fixed search://web target.',
        errorCode: 'TARGET_ARGUMENT_MISMATCH',
        evidence: [],
      };
    }
    const query = typeof proposal.args.query === 'string'
      ? proposal.args.query.trim().slice(0, 500)
      : '';
    if (!query) {
      return {
        success: false,
        summary: 'A non-empty search query is required.',
        errorCode: 'SEARCH_QUERY_INVALID',
        evidence: [],
      };
    }

    const maxResults = boundedInteger(
      proposal.args.maxResults,
      this.options.maxResults ?? 5,
      1,
      Math.min(10, this.options.maxResults ?? 10),
    );
    const failures: string[] = [];
    for (const provider of this.providers()) {
      try {
        const observation = await this.search(provider, query, maxResults, proposal.args, signal);
        const results = observation.results;
      this.observations.set(proposal.id, observation);
      return {
        success: true,
        summary: `Web search via ${provider} returned ${results.length} source${results.length === 1 ? '' : 's'}.`,
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest(observation),
        }],
      };
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      success: false,
      summary: `All configured search providers failed: ${failures.join(' | ')}`,
      errorCode: 'WEB_SEARCH_FAILED',
      evidence: [],
    };
  }

  async observe(proposal: ActionProposal<WebSearchArgs>): Promise<Observation> {
    const observation = this.observations.get(proposal.id);
    return {
      target: proposal.target,
      exists: !!observation && observation.results.length > 0,
      value: observation,
      evidence: [{
        id: `observation:${proposal.id}`,
        kind: 'observation',
        source: this.manifest.id,
        digest: digest(observation ?? { missing: true }),
      }],
    };
  }

  async verify(
    _proposal: ActionProposal<WebSearchArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const value = observation.value as WebSearchObservation | undefined;
    const passed = execution.success
      && observation.exists
      && !!value
      && value.results.length > 0;
    return {
      passed,
      reasonCodes: passed ? ['WEB_SEARCH_RESULTS_OBSERVED'] : ['WEB_SEARCH_RESULTS_NOT_VERIFIED'],
      evidence: observation.evidence,
    };
  }
}

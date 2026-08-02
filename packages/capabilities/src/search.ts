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
  provider: 'tavily';
  query: string;
  results: WebSearchResult[];
  requestId?: string;
}

export interface WebSearchCapabilityOptions {
  tavilyApiKey: string;
  endpoint?: string;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

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

export class WebSearchCapability implements CapabilityAdapter<WebSearchArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'network.web.search',
    version: '0.2.0',
    description: 'Search the public web through the configured server-side search provider.',
    effects: ['network.request', 'state.read'],
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
    if (!options.tavilyApiKey.trim()) throw new Error('Tavily API key is required.');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(
    proposal: ActionProposal<WebSearchArgs>,
    grant: CapabilityGrant,
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

    try {
      const maxResults = boundedInteger(
        proposal.args.maxResults,
        this.options.maxResults ?? 5,
        1,
        Math.min(10, this.options.maxResults ?? 10),
      );
      const response = await this.fetchImpl(
        this.options.endpoint ?? 'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.tavilyApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            query,
            max_results: maxResults,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            topic: proposal.args.topic ?? 'general',
            ...(proposal.args.timeRange ? { time_range: proposal.args.timeRange } : {}),
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        },
      );
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error('Search response exceeds the 1 MB limit.');
      if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
      const body = JSON.parse(text) as Record<string, unknown>;
      const rawResults = Array.isArray(body.results) ? body.results : [];
      const results = rawResults.slice(0, maxResults).flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const url = optionalString(record.url, 2_000);
        const title = optionalString(record.title, 500);
        if (!url || !title) return [];
        return [{
          title,
          url,
          snippet: optionalString(record.content, 4_000) ?? '',
          ...(typeof record.score === 'number' && Number.isFinite(record.score)
            ? { score: record.score }
            : {}),
          ...(optionalString(record.published_date, 100)
            ? { publishedAt: optionalString(record.published_date, 100) }
            : {}),
        } satisfies WebSearchResult];
      });
      const observation: WebSearchObservation = {
        provider: 'tavily',
        query,
        results,
        ...(optionalString(body.request_id, 300) ? { requestId: optionalString(body.request_id, 300) } : {}),
      };
      this.observations.set(proposal.id, observation);
      return {
        success: results.length > 0,
        summary: results.length > 0
          ? `Web search returned ${results.length} source${results.length === 1 ? '' : 's'}.`
          : 'Web search returned no usable sources.',
        errorCode: results.length > 0 ? undefined : 'SEARCH_RESULTS_EMPTY',
        evidence: [{
          id: `tool:${proposal.id}`,
          kind: 'tool_result',
          source: this.manifest.id,
          digest: digest(observation),
        }],
      };
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        errorCode: 'WEB_SEARCH_FAILED',
        evidence: [],
      };
    }
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

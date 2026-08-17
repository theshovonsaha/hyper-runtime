import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { validateGrant } from './shared';
import { digest } from './shared';

export interface RemoteCapabilityClient {
  execute(
    manifest: CapabilityManifest,
    proposal: ActionProposal,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution>;
  observe(manifest: CapabilityManifest, proposal: ActionProposal): Promise<Observation>;
  verify(
    manifest: CapabilityManifest,
    proposal: ActionProposal,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult>;
}

export class RemoteCapabilityAdapter implements CapabilityAdapter {
  constructor(
    readonly manifest: CapabilityManifest,
    private readonly client: RemoteCapabilityClient,
  ) {
    if (manifest.effects.length === 0 || manifest.targetPatterns.length === 0) {
      throw new Error('Remote capability manifests require explicit effects and target patterns.');
    }
  }

  async execute(
    proposal: ActionProposal,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const requiredEffect = proposal.declaredEffects[0];
    if (!requiredEffect) {
      return {
        success: false,
        summary: 'Remote proposal declares no effect.',
        errorCode: 'MISSING_DECLARED_EFFECT',
        evidence: [],
      };
    }
    const invalid = validateGrant(proposal, grant, this.manifest, requiredEffect);
    if (invalid) return invalid;
    return this.client.execute(this.manifest, proposal, grant);
  }

  async observe(proposal: ActionProposal): Promise<Observation> {
    return this.client.observe(this.manifest, proposal);
  }

  async verify(
    proposal: ActionProposal,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    return this.client.verify(this.manifest, proposal, execution, observation);
  }
}

export interface McpToolAuthority {
  toolName: string;
  observationToolName: string;
  effects: CapabilityManifest['effects'];
  requiredEffects?: CapabilityManifest['requiredEffects'];
  targetPatterns: string[];
  riskCeiling: CapabilityManifest['riskCeiling'];
  approval: CapabilityManifest['approval'];
}

export interface StreamableHttpMcpOptions {
  endpoint: string;
  allowedEndpoints: string[];
  authorization?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  protocolVersion?: string;
  timeoutMs?: number;
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: CapabilityManifest['inputSchema'];
}

interface McpCallResult {
  isError?: boolean;
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

/**
 * Minimal Streamable HTTP MCP client. Discovery never grants authority:
 * callers must supply a server-owned authority record and an independent
 * observation tool before a discovered tool can become a capability.
 */
export class StreamableHttpMcpClient {
  private readonly endpoint: string;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private initialized = false;
  private requestId = 0;

  constructor(private readonly options: StreamableHttpMcpOptions) {
    this.endpoint = new URL(options.endpoint).toString();
    const allowed = new Set(options.allowedEndpoints.map(value => new URL(value).toString()));
    if (!allowed.has(this.endpoint)) throw new Error('MCP endpoint is not in the server allowlist.');
    if (!this.endpoint.startsWith('https://') && !this.endpoint.startsWith('http://127.0.0.1') && !this.endpoint.startsWith('http://localhost')) {
      throw new Error('Remote MCP endpoints require HTTPS; plaintext is limited to loopback.');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 100), 60_000);
  }

  private async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
    this.requestId += 1;
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': method,
        ...(method === 'tools/call' && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.options.authorization ? { authorization: this.options.authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.requestId, method, params }),
    });
    if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    const payload = contentType.includes('text/event-stream')
      ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6)
      : raw;
    if (!payload) throw new Error(`MCP ${method} returned no JSON-RPC response.`);
    const parsed = JSON.parse(payload) as Record<string, any>;
    if (parsed.error) throw new Error(`MCP ${method} failed: ${String(parsed.error.message ?? parsed.error.code)}`);
    if (!parsed.result || typeof parsed.result !== 'object') throw new Error(`MCP ${method} returned an invalid result.`);
    return parsed.result;
  }

  private async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': method,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.options.authorization ? { authorization: this.options.authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    });
    if (!response.ok) throw new Error(`MCP ${method} notification returned HTTP ${response.status}.`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: this.options.protocolVersion ?? '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'hyper-runtime', version: '0.2.0' },
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescription[]> {
    await this.initialize();
    const discovered: McpToolDescription[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error('MCP tools/list returned an invalid tool list.');
      for (const value of result.tools.slice(0, 500)) {
        if (!value || typeof value.name !== 'string' || !value.inputSchema || value.inputSchema.type !== 'object') continue;
        discovered.push({ name: value.name, description: typeof value.description === 'string' ? value.description : undefined, inputSchema: value.inputSchema });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor && discovered.length < 500);
    return discovered;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    return this.request('tools/call', { name, arguments: args }) as Promise<McpCallResult>;
  }
}

export async function discoverMcpCapabilities(
  client: StreamableHttpMcpClient,
  authorities: McpToolAuthority[],
): Promise<RemoteCapabilityAdapter[]> {
  const tools = await client.listTools();
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return authorities.flatMap(authority => {
    const tool = byName.get(authority.toolName);
    if (!tool || !byName.has(authority.observationToolName) || authority.effects.length === 0 || authority.targetPatterns.length === 0) return [];
    const results = new Map<string, McpCallResult>();
    const observations = new Map<string, McpCallResult>();
    const manifest: CapabilityManifest = {
      id: `mcp.${authority.toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      version: '0.2.0',
      description: tool.description,
      effects: [...authority.effects],
      requiredEffects: authority.requiredEffects ? [...authority.requiredEffects] : [authority.effects[0]!],
      targetPatterns: [...authority.targetPatterns],
      riskCeiling: authority.riskCeiling,
      approval: authority.approval,
      idempotent: false,
      verification: 'required',
      inputSchema: tool.inputSchema,
    };
    return [new RemoteCapabilityAdapter(manifest, {
      async execute(_manifest, proposal) {
        const result = await client.callTool(authority.toolName, proposal.args);
        results.set(proposal.id, result);
        return {
          success: result.isError !== true,
          summary: result.isError ? 'MCP tool reported an error.' : `MCP tool ${authority.toolName} returned a result.`,
          errorCode: result.isError ? 'MCP_TOOL_ERROR' : undefined,
          evidence: result.isError ? [] : [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: manifest.id, digest: digest(result) }],
        };
      },
      async observe(_manifest, proposal) {
        const result = await client.callTool(authority.observationToolName, proposal.args);
        observations.set(proposal.id, result);
        return {
          target: proposal.target,
          exists: result.isError !== true,
          value: result.structuredContent ?? result.content,
          evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: manifest.id, digest: digest(result) }],
        };
      },
      async verify(_manifest, proposal, execution, observation) {
        const independentlyObserved = observations.has(proposal.id) && results.has(proposal.id);
        const passed = execution.success && observation.exists && independentlyObserved;
        return { passed, reasonCodes: passed ? ['MCP_RESULT_INDEPENDENTLY_OBSERVED'] : ['MCP_RESULT_NOT_VERIFIED'], evidence: observation.evidence };
      },
    })];
  });
}

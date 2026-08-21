import { timingSafeEqual } from 'node:crypto';
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

export interface ChannelDeliveryArgs extends Record<string, unknown> {
  recipient: string;
  content: string;
}

export interface ChannelDeliveryReceipt {
  deliveryId: string;
  recipient: string;
  status: 'accepted' | 'delivered' | 'failed';
  observedAt: string;
}

export interface ChannelTransport {
  send(input: { recipient: string; content: string; idempotencyKey: string }): Promise<ChannelDeliveryReceipt>;
  observe(deliveryId: string): Promise<ChannelDeliveryReceipt>;
}

export interface BoundedChannelOptions {
  id: string;
  allowedRecipients: string[];
  transport: ChannelTransport;
  maxContentBytes?: number;
}

export interface HttpChannelTransportOptions {
  endpoint: string;
  statusBaseUrl: string;
  authorization?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export class HttpChannelTransport implements ChannelTransport {
  private readonly endpoint: URL;
  private readonly statusBase: URL;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: HttpChannelTransportOptions) {
    this.endpoint = new URL(options.endpoint);
    this.statusBase = new URL(options.statusBaseUrl);
    if (this.endpoint.origin !== this.statusBase.origin) throw new Error('Channel send and observation endpoints must share an origin.');
    if (this.endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(this.endpoint.hostname)) throw new Error('Remote channel endpoints require HTTPS.');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json', ...(this.options.authorization ? { authorization: this.options.authorization } : {}) };
  }

  async send(input: { recipient: string; content: string; idempotencyKey: string }): Promise<ChannelDeliveryReceipt> {
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000), headers: { ...this.headers(), 'idempotency-key': input.idempotencyKey }, body: JSON.stringify({ recipient: input.recipient, content: input.content }) });
    if (!response.ok) throw new Error(`Channel send returned HTTP ${response.status}.`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.deliveryId !== 'string' || !['accepted', 'delivered', 'failed'].includes(String(value.status))) throw new Error('Channel send returned an invalid receipt.');
    return { deliveryId: value.deliveryId, recipient: input.recipient, status: value.status as ChannelDeliveryReceipt['status'], observedAt: typeof value.observedAt === 'string' ? value.observedAt : new Date().toISOString() };
  }

  async observe(deliveryId: string): Promise<ChannelDeliveryReceipt> {
    const url = new URL(encodeURIComponent(deliveryId), this.statusBase.toString().replace(/\/?$/, '/'));
    if (url.origin !== this.statusBase.origin) throw new Error('Channel observation escaped its configured origin.');
    const response = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000), headers: this.headers() });
    if (!response.ok) throw new Error(`Channel observation returned HTTP ${response.status}.`);
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.deliveryId !== 'string' || typeof value.recipient !== 'string' || !['accepted', 'delivered', 'failed'].includes(String(value.status))) throw new Error('Channel observation returned an invalid receipt.');
    return { deliveryId: value.deliveryId, recipient: value.recipient, status: value.status as ChannelDeliveryReceipt['status'], observedAt: typeof value.observedAt === 'string' ? value.observedAt : new Date().toISOString() };
  }
}

export class BoundedChannelCapability implements CapabilityAdapter<ChannelDeliveryArgs> {
  readonly manifest: CapabilityManifest;
  private readonly receipts = new Map<string, ChannelDeliveryReceipt>();

  constructor(private readonly options: BoundedChannelOptions) {
    if (!/^[a-z0-9_-]+$/i.test(options.id) || options.allowedRecipients.length === 0) {
      throw new Error('Channel capabilities require a stable ID and recipient allowlist.');
    }
    this.manifest = {
      id: `channel.${options.id}.send`,
      version: '0.2.0',
      description: `Deliver a bounded message through ${options.id}.`,
      effects: ['network.request', 'state.write'],
      requiredEffects: ['network.request', 'state.write'],
      targetPatterns: options.allowedRecipients.map(recipient => `channel://${options.id}/${recipient}`),
      riskCeiling: 4,
      approval: 'always',
      idempotent: true,
      verification: 'required',
      inputSchema: {
        type: 'object',
        required: ['recipient', 'content'],
        properties: { recipient: { type: 'string' }, content: { type: 'string' } },
        additionalProperties: false,
      },
    };
  }

  async execute(proposal: ActionProposal<ChannelDeliveryArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    const expectedTarget = `channel://${this.options.id}/${proposal.args.recipient}`;
    if (proposal.target !== expectedTarget || !this.options.allowedRecipients.includes(proposal.args.recipient)) {
      return { success: false, summary: 'Channel recipient is outside the configured allowlist.', errorCode: 'CHANNEL_RECIPIENT_NOT_ALLOWED', evidence: [] };
    }
    if (Buffer.byteLength(proposal.args.content) > (this.options.maxContentBytes ?? 20_000)) {
      return { success: false, summary: 'Channel content exceeds the configured byte limit.', errorCode: 'CHANNEL_CONTENT_TOO_LARGE', evidence: [] };
    }
    try {
      const receipt = await this.options.transport.send({ recipient: proposal.args.recipient, content: proposal.args.content, idempotencyKey: proposal.idempotencyKey });
      this.receipts.set(proposal.id, receipt);
      return { success: receipt.status !== 'failed', summary: `Channel accepted delivery ${receipt.deliveryId}.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(receipt) }] };
    } catch (error) {
      return { success: false, summary: error instanceof Error ? error.message : String(error), errorCode: 'CHANNEL_DELIVERY_FAILED', evidence: [] };
    }
  }

  async observe(proposal: ActionProposal<ChannelDeliveryArgs>): Promise<Observation> {
    const receipt = this.receipts.get(proposal.id);
    if (!receipt) return { target: proposal.target, exists: false, evidence: [] };
    const observed = await this.options.transport.observe(receipt.deliveryId);
    return { target: proposal.target, exists: true, value: observed, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(observed) }] };
  }

  async verify(proposal: ActionProposal<ChannelDeliveryArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    const value = observation.value as ChannelDeliveryReceipt | undefined;
    const passed = execution.success && observation.exists && value?.recipient === proposal.args.recipient && value.status === 'delivered';
    return { passed, reasonCodes: passed ? ['CHANNEL_DELIVERY_OBSERVED'] : ['CHANNEL_DELIVERY_NOT_CONFIRMED'], evidence: observation.evidence };
  }
}

export interface GatewayInboundMessage {
  channelId: string;
  sender: string;
  messageId: string;
  content: string;
  receivedAt: string;
  provenance: string[];
}

export class AuthenticatedGatewayIngress {
  constructor(
    private readonly channelId: string,
    private readonly secret: string,
    private readonly allowedSenders: string[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!secret || allowedSenders.length === 0) throw new Error('Gateway ingress requires a secret and sender allowlist.');
  }

  receive(token: string, value: { sender?: unknown; messageId?: unknown; content?: unknown }): GatewayInboundMessage {
    const provided = Buffer.from(token);
    const expected = Buffer.from(this.secret);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('GATEWAY_AUTHENTICATION_FAILED');
    const sender = typeof value.sender === 'string' ? value.sender : '';
    if (!this.allowedSenders.includes(sender)) throw new Error('GATEWAY_SENDER_NOT_ALLOWED');
    const messageId = typeof value.messageId === 'string' ? value.messageId.slice(0, 300) : '';
    const content = typeof value.content === 'string' ? value.content.slice(0, 20_000) : '';
    if (!messageId || !content) throw new Error('GATEWAY_MESSAGE_INVALID');
    return { channelId: this.channelId, sender, messageId, content, receivedAt: this.now(), provenance: [`gateway:${this.channelId}`, `sender:${sender}`, `message:${messageId}`] };
  }
}

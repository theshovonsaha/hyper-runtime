import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
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

export interface HttpGetArgs extends Record<string, unknown> {
  url: string;
  expectedStatus?: number;
  maxBytes?: number;
}

interface HttpObservation {
  url: string;
  status: number;
  body: string;
  contentType: string;
}

export interface HttpCapabilityOptions {
  allowedHosts: string[];
  allowHttp?: boolean;
  maxRedirects?: number;
  maxBytes?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

function ipv4Private(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127)
    || a! >= 224;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4Private(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map(entry => entry.address);
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`HTTP response exceeds ${maxBytes} byte limit.`);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export class AllowlistedHttpCapability implements CapabilityAdapter<HttpGetArgs> {
  readonly manifest: CapabilityManifest;
  private readonly observations = new Map<string, HttpObservation>();
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;

  constructor(private readonly options: HttpCapabilityOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.manifest = {
      id: 'network.http.get',
      version: '0.2.0',
      effects: ['network.request', 'state.read'],
      targetPatterns: options.allowedHosts.flatMap(host => [
        `https://${host}/**`,
        ...(options.allowHttp ? [`http://${host}/**`] : []),
      ]),
      riskCeiling: 3,
      approval: 'risk_based',
      idempotent: true,
      verification: 'required',
    };
  }

  private async validateUrl(value: string): Promise<URL> {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('Credentials in URLs are forbidden.');
    if (url.protocol !== 'https:' && !(this.options.allowHttp && url.protocol === 'http:')) {
      throw new Error('URL protocol is not allowed.');
    }
    if (!this.options.allowedHosts.includes(url.hostname)) {
      throw new Error('URL host is not allowlisted.');
    }
    const addresses = await this.resolveHost(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new Error('URL resolves to a private, special, or unknown address.');
    }
    return url;
  }

  async execute(
    proposal: ActionProposal<HttpGetArgs>,
    grant: CapabilityGrant,
  ): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (proposal.args.url !== proposal.target) {
      return {
        success: false,
        summary: 'The requested URL differs from the authorized target.',
        errorCode: 'TARGET_ARGUMENT_MISMATCH',
        evidence: [],
      };
    }

    try {
      let url = await this.validateUrl(proposal.args.url);
      let response: Response | undefined;
      const maxRedirects = this.options.maxRedirects ?? 3;
      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        response = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'text/plain, application/json, text/html' },
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location || redirects === maxRedirects) throw new Error('Redirect limit exceeded.');
        url = await this.validateUrl(new URL(location, url).toString());
      }
      if (!response) throw new Error('No HTTP response received.');
      const body = await readLimited(
        response,
        proposal.args.maxBytes ?? this.options.maxBytes ?? 1_000_000,
      );
      const observation: HttpObservation = {
        url: url.toString(),
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? '',
      };
      this.observations.set(proposal.id, observation);
      const expected = proposal.args.expectedStatus ?? 200;
      return {
        success: response.status === expected,
        summary: `GET ${url.hostname} returned ${response.status} and ${body.length} characters.`,
        errorCode: response.status === expected ? undefined : 'UNEXPECTED_HTTP_STATUS',
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
        errorCode: 'HTTP_REQUEST_FAILED',
        evidence: [],
      };
    }
  }

  async observe(proposal: ActionProposal<HttpGetArgs>): Promise<Observation> {
    const observation = this.observations.get(proposal.id);
    return {
      target: proposal.target,
      exists: !!observation,
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
    proposal: ActionProposal<HttpGetArgs>,
    execution: CapabilityExecution,
    observation: Observation,
  ): Promise<VerificationResult> {
    const value = observation.value as HttpObservation | undefined;
    const passed = execution.success
      && observation.exists
      && value?.status === (proposal.args.expectedStatus ?? 200);
    return {
      passed,
      reasonCodes: passed ? ['HTTP_RESPONSE_OBSERVED'] : ['HTTP_RESPONSE_NOT_VERIFIED'],
      evidence: observation.evidence,
    };
  }
}

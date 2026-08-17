import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname } from 'node:path';
import type {
  ActionProposal,
  CapabilityAdapter,
  CapabilityExecution,
  CapabilityGrant,
  CapabilityManifest,
  Observation,
  VerificationResult,
} from '@hyper/contracts';
import { digest, validateGrant, WorkspaceTargetResolver } from './shared';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const AUDIO_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

const IMAGE_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

interface WorkspaceMedia {
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

interface TranscriptObservation {
  provider: 'deepgram' | 'elevenlabs';
  model: string;
  input: { target: string; bytes: number; mimeType: string; sha256: string };
  transcript: string;
  language?: string;
  confidence?: number;
  requestId?: string;
  semanticVerification: 'provider_response_only';
}

interface GeneratedArtifactObservation {
  provider: string;
  model: string;
  target: string;
  bytes: number;
  mimeType: string;
  sha256: string;
}

interface VisionObservation {
  provider: string;
  model: string;
  input: { target: string; bytes: number; mimeType: string; sha256: string };
  analysis: string;
  semanticVerification: 'provider_response_only';
}

function binaryDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasArtifactSignature(bytes: Uint8Array, format: string): boolean {
  if (format === 'png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (format === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (format === 'webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  if (format === 'mp3') {
    return new TextDecoder().decode(bytes.slice(0, 3)) === 'ID3'
      || (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0);
  }
  if (format === 'wav') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WAVE';
  }
  return false;
}

function cleanString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

async function workspaceMedia(
  resolver: WorkspaceTargetResolver,
  target: string,
  types: Record<string, string>,
  maxBytes: number,
): Promise<WorkspaceMedia> {
  const path = resolver.resolve(target);
  const mimeType = types[extname(path).toLowerCase()];
  if (!mimeType) throw new Error('The workspace media type is not supported.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The media target is not a regular file.');
  if (info.size <= 0 || info.size > maxBytes) {
    throw new Error(`Media must contain 1-${maxBytes} bytes.`);
  }
  const bytes = new Uint8Array(await readFile(path));
  return { bytes, mimeType, sha256: binaryDigest(bytes) };
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`Provider response exceeds ${maxBytes} bytes.`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Provider response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function responseJson(response: Response, maxBytes = 2_000_000): Promise<Record<string, any>> {
  const bytes = await responseBytes(response, maxBytes);
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider returned an invalid JSON object.');
  }
  return value as Record<string, any>;
}

async function atomicWrite(
  resolver: WorkspaceTargetResolver,
  target: string,
  bytes: Uint8Array,
  proposalId: string,
): Promise<void> {
  const path = resolver.resolve(target, true);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.hyper-${digest(proposalId).slice(0, 12)}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, path);
}

function executionFailure(error: unknown, code: string): CapabilityExecution {
  return {
    success: false,
    summary: error instanceof Error ? error.message : String(error),
    errorCode: code,
    evidence: [],
  };
}

function observedVerification(
  execution: CapabilityExecution,
  observation: Observation,
  passedCode: string,
  failedCode: string,
): VerificationResult {
  const passed = execution.success && observation.exists;
  return {
    passed,
    reasonCodes: [passed ? passedCode : failedCode],
    evidence: observation.evidence,
  };
}

export interface TranscriptionArgs extends Record<string, unknown> {
  language?: string;
  diarize?: boolean;
}

export interface SpeechSynthesisArgs extends Record<string, unknown> {
  text: string;
  voiceId?: string;
  speed?: number;
}

export interface VisionAnalysisArgs extends Record<string, unknown> {
  prompt: string;
  detail?: 'low' | 'high' | 'auto';
}

export interface ImageGenerationArgs extends Record<string, unknown> {
  prompt: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
}

export interface VoiceAgentSessionArgs extends Record<string, unknown> {
  agentId: string;
  branchId?: string;
  environment?: string;
}

interface SharedProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface DeepgramOptions extends SharedProviderOptions {}

export class DeepgramTranscriptionCapability implements CapabilityAdapter<TranscriptionArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.audio.transcribe.deepgram',
    version: '0.2.0',
    description: 'Transcribe a bounded workspace audio or video file with Deepgram.',
    effects: ['state.read', 'network.request'],
    requiredEffects: ['state.read', 'network.request'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 3,
    approval: 'always',
    idempotent: false,
    verification: 'required',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        diarize: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, TranscriptObservation>();

  constructor(root: string, private readonly options: DeepgramOptions) {
    if (!options.apiKey.trim()) throw new Error('Deepgram API key is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<TranscriptionArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.read')) return executionFailure('The grant does not authorize media reads.', 'INVALID_GRANT');
    try {
      const input = await workspaceMedia(this.resolver, proposal.target, AUDIO_TYPES, this.options.maxInputBytes ?? 25_000_000);
      const url = new URL('/v1/listen', this.options.baseUrl ?? 'https://api.deepgram.com');
      url.searchParams.set('model', this.options.model);
      url.searchParams.set('smart_format', 'true');
      const language = cleanString(proposal.args.language, 40);
      if (language) url.searchParams.set('language', language);
      if (proposal.args.diarize === true) url.searchParams.set('diarize_model', 'latest');
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Token ${this.options.apiKey}`, 'content-type': input.mimeType, accept: 'application/json' },
        body: input.bytes,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      const body = await responseJson(response);
      const alternative = body.results?.channels?.[0]?.alternatives?.[0];
      const transcript = cleanString(alternative?.transcript, 250_000);
      if (!transcript) throw new Error('Deepgram returned no transcript.');
      const observation: TranscriptObservation = {
        provider: 'deepgram',
        model: this.options.model,
        input: { target: proposal.target, bytes: input.bytes.byteLength, mimeType: input.mimeType, sha256: input.sha256 },
        transcript,
        ...(cleanString(body.results?.channels?.[0]?.detected_language, 40) ? { language: body.results.channels[0].detected_language } : {}),
        ...(typeof alternative?.confidence === 'number' ? { confidence: alternative.confidence } : {}),
        ...(cleanString(body.metadata?.request_id, 200) ? { requestId: body.metadata.request_id } : {}),
        semanticVerification: 'provider_response_only',
      };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `Deepgram transcribed ${input.bytes.byteLength} bytes into ${transcript.length} characters.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }] };
    } catch (error) {
      return executionFailure(error, 'DEEPGRAM_TRANSCRIPTION_FAILED');
    }
  }

  async observe(proposal: ActionProposal<TranscriptionArgs>): Promise<Observation> {
    const value = this.observations.get(proposal.id);
    return { target: proposal.target, exists: !!value, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { missing: true }) }] };
  }

  async verify(_proposal: ActionProposal<TranscriptionArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'TRANSCRIPT_PROVIDER_RESPONSE_OBSERVED', 'TRANSCRIPT_NOT_OBSERVED');
  }
}

export class DeepgramSpeechSynthesisCapability implements CapabilityAdapter<SpeechSynthesisArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.audio.synthesize.deepgram',
    version: '0.2.0',
    description: 'Generate a bounded workspace audio artifact with Deepgram.',
    effects: ['network.request', 'state.write'],
    requiredEffects: ['network.request', 'state.write'],
    targetPatterns: ['workspace/**'],
    riskCeiling: 4,
    approval: 'always',
    idempotent: false,
    verification: 'required',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: { text: { type: 'string' }, speed: { type: 'number' } },
      additionalProperties: false,
    },
  };

  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, GeneratedArtifactObservation>();

  constructor(root: string, private readonly options: DeepgramOptions) {
    if (!options.apiKey.trim()) throw new Error('Deepgram API key is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<SpeechSynthesisArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.write')) return executionFailure('The grant does not authorize artifact writes.', 'INVALID_GRANT');
    try {
      const text = cleanString(proposal.args.text, 20_000);
      if (!text) throw new Error('Speech text is required.');
      const extension = extname(proposal.target).toLowerCase();
      if (extension !== '.mp3' && extension !== '.wav') throw new Error('Deepgram speech output must end in .mp3 or .wav.');
      const url = new URL('/v1/speak', this.options.baseUrl ?? 'https://api.deepgram.com');
      url.searchParams.set('model', this.options.model);
      url.searchParams.set('encoding', extension === '.mp3' ? 'mp3' : 'linear16');
      if (extension === '.wav') url.searchParams.set('container', 'wav');
      if (typeof proposal.args.speed === 'number' && proposal.args.speed >= 0.7 && proposal.args.speed <= 1.5) url.searchParams.set('speed', String(proposal.args.speed));
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Token ${this.options.apiKey}`, 'content-type': 'application/json', accept: AUDIO_TYPES[extension]! },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      if (!response.ok) throw new Error(`Deepgram returned HTTP ${response.status}.`);
      const bytes = await responseBytes(response, this.options.maxOutputBytes ?? 25_000_000);
      if (!bytes.byteLength) throw new Error('Deepgram returned empty audio.');
      if (!hasArtifactSignature(bytes, extension === '.mp3' ? 'mp3' : 'wav')) throw new Error('Deepgram returned bytes that do not match the requested audio format.');
      await atomicWrite(this.resolver, proposal.target, bytes, proposal.id);
      const observation: GeneratedArtifactObservation = { provider: 'deepgram', model: this.options.model, target: proposal.target, bytes: bytes.byteLength, mimeType: AUDIO_TYPES[extension]!, sha256: binaryDigest(bytes) };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `Deepgram generated ${bytes.byteLength} bytes at ${proposal.target}.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: observation.sha256 }] };
    } catch (error) {
      return executionFailure(error, 'DEEPGRAM_SPEECH_SYNTHESIS_FAILED');
    }
  }

  async observe(proposal: ActionProposal<SpeechSynthesisArgs>): Promise<Observation> {
    try {
      const expected = this.observations.get(proposal.id);
      const actual = await workspaceMedia(this.resolver, proposal.target, AUDIO_TYPES, this.options.maxOutputBytes ?? 25_000_000);
      const exists = !!expected && actual.sha256 === expected.sha256;
      const value = exists ? { ...expected, bytes: actual.bytes.byteLength, sha256: actual.sha256 } : undefined;
      return { target: proposal.target, exists, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { mismatch: true }) }] };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ missing: true }) }] };
    }
  }

  async verify(_proposal: ActionProposal<SpeechSynthesisArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'AUDIO_ARTIFACT_DIGEST_OBSERVED', 'AUDIO_ARTIFACT_NOT_VERIFIED');
  }
}

export interface ElevenLabsOptions extends SharedProviderOptions {
  voiceId?: string;
}

export class ElevenLabsTranscriptionCapability implements CapabilityAdapter<TranscriptionArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.audio.transcribe.elevenlabs', version: '0.2.0',
    description: 'Transcribe a bounded workspace audio or video file with ElevenLabs Scribe.',
    effects: ['state.read', 'network.request'], requiredEffects: ['state.read', 'network.request'],
    targetPatterns: ['workspace/**'], riskCeiling: 3, approval: 'always', idempotent: false, verification: 'required',
    inputSchema: { type: 'object', properties: { language: { type: 'string' }, diarize: { type: 'boolean' } }, additionalProperties: false },
  };
  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, TranscriptObservation>();

  constructor(root: string, private readonly options: ElevenLabsOptions) {
    if (!options.apiKey.trim()) throw new Error('ElevenLabs API key is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<TranscriptionArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.read')) return executionFailure('The grant does not authorize media reads.', 'INVALID_GRANT');
    try {
      const input = await workspaceMedia(this.resolver, proposal.target, AUDIO_TYPES, this.options.maxInputBytes ?? 25_000_000);
      const form = new FormData();
      form.set('file', new Blob([input.bytes], { type: input.mimeType }), proposal.target.split('/').at(-1) ?? 'audio');
      form.set('model_id', this.options.model);
      const language = cleanString(proposal.args.language, 40);
      if (language) form.set('language_code', language);
      if (proposal.args.diarize === true) form.set('diarize', 'true');
      const response = await this.fetchImpl(new URL('/v1/speech-to-text', this.options.baseUrl ?? 'https://api.elevenlabs.io'), {
        method: 'POST', headers: { 'xi-api-key': this.options.apiKey, accept: 'application/json' }, body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      const body = await responseJson(response);
      const transcript = cleanString(body.text, 250_000);
      if (!transcript) throw new Error('ElevenLabs returned no transcript.');
      const observation: TranscriptObservation = {
        provider: 'elevenlabs', model: this.options.model,
        input: { target: proposal.target, bytes: input.bytes.byteLength, mimeType: input.mimeType, sha256: input.sha256 },
        transcript,
        ...(cleanString(body.language_code, 40) ? { language: body.language_code } : {}),
        ...(typeof body.language_probability === 'number' ? { confidence: body.language_probability } : {}),
        semanticVerification: 'provider_response_only',
      };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `ElevenLabs transcribed ${input.bytes.byteLength} bytes into ${transcript.length} characters.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }] };
    } catch (error) {
      return executionFailure(error, 'ELEVENLABS_TRANSCRIPTION_FAILED');
    }
  }

  async observe(proposal: ActionProposal<TranscriptionArgs>): Promise<Observation> {
    const value = this.observations.get(proposal.id);
    return { target: proposal.target, exists: !!value, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { missing: true }) }] };
  }

  async verify(_proposal: ActionProposal<TranscriptionArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'TRANSCRIPT_PROVIDER_RESPONSE_OBSERVED', 'TRANSCRIPT_NOT_OBSERVED');
  }
}

export class ElevenLabsSpeechSynthesisCapability implements CapabilityAdapter<SpeechSynthesisArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.audio.synthesize.elevenlabs', version: '0.2.0',
    description: 'Generate a bounded workspace audio artifact with ElevenLabs.',
    effects: ['network.request', 'state.write'], requiredEffects: ['network.request', 'state.write'],
    targetPatterns: ['workspace/**'], riskCeiling: 4, approval: 'always', idempotent: false, verification: 'required',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, voiceId: { type: 'string' }, speed: { type: 'number' } }, additionalProperties: false },
  };
  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, GeneratedArtifactObservation>();

  constructor(root: string, private readonly options: ElevenLabsOptions) {
    if (!options.apiKey.trim()) throw new Error('ElevenLabs API key is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<SpeechSynthesisArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.write')) return executionFailure('The grant does not authorize artifact writes.', 'INVALID_GRANT');
    try {
      const text = cleanString(proposal.args.text, 20_000);
      const voiceId = cleanString(proposal.args.voiceId, 200) ?? this.options.voiceId;
      if (!text) throw new Error('Speech text is required.');
      if (!voiceId || !/^[A-Za-z0-9_-]+$/.test(voiceId)) throw new Error('A valid ElevenLabs voice ID is required.');
      const extension = extname(proposal.target).toLowerCase();
      if (extension !== '.mp3') throw new Error('ElevenLabs speech output must end in .mp3.');
      const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, this.options.baseUrl ?? 'https://api.elevenlabs.io');
      url.searchParams.set('output_format', 'mp3_44100_128');
      const response = await this.fetchImpl(url, {
        method: 'POST', headers: { 'xi-api-key': this.options.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.options.model, ...(typeof proposal.args.speed === 'number' ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, proposal.args.speed)) } } : {}) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}.`);
      const bytes = await responseBytes(response, this.options.maxOutputBytes ?? 25_000_000);
      if (!bytes.byteLength) throw new Error('ElevenLabs returned empty audio.');
      if (!hasArtifactSignature(bytes, 'mp3')) throw new Error('ElevenLabs returned bytes that are not MP3 audio.');
      await atomicWrite(this.resolver, proposal.target, bytes, proposal.id);
      const observation: GeneratedArtifactObservation = { provider: 'elevenlabs', model: this.options.model, target: proposal.target, bytes: bytes.byteLength, mimeType: 'audio/mpeg', sha256: binaryDigest(bytes) };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `ElevenLabs generated ${bytes.byteLength} bytes at ${proposal.target}.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: observation.sha256 }] };
    } catch (error) {
      return executionFailure(error, 'ELEVENLABS_SPEECH_SYNTHESIS_FAILED');
    }
  }

  async observe(proposal: ActionProposal<SpeechSynthesisArgs>): Promise<Observation> {
    try {
      const expected = this.observations.get(proposal.id);
      const actual = await workspaceMedia(this.resolver, proposal.target, { '.mp3': 'audio/mpeg' }, this.options.maxOutputBytes ?? 25_000_000);
      const exists = !!expected && actual.sha256 === expected.sha256;
      const value = exists ? { ...expected, bytes: actual.bytes.byteLength, sha256: actual.sha256 } : undefined;
      return { target: proposal.target, exists, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { mismatch: true }) }] };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ missing: true }) }] };
    }
  }

  async verify(_proposal: ActionProposal<SpeechSynthesisArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'AUDIO_ARTIFACT_DIGEST_OBSERVED', 'AUDIO_ARTIFACT_NOT_VERIFIED');
  }
}

interface BrokerSession { signedUrl: string; expiresAt: number }

export class EphemeralVoiceSessionBroker {
  private readonly sessions = new Map<string, BrokerSession>();

  issue(signedUrl: string, ttlMs = 14 * 60_000): { handle: string; expiresAt: string } {
    const url = new URL(signedUrl);
    if (url.protocol !== 'wss:' || url.hostname !== 'api.elevenlabs.io') {
      throw new Error('Voice provider returned an untrusted WebSocket URL.');
    }
    const handle = crypto.randomUUID();
    const expiresAt = Date.now() + Math.min(15 * 60_000, Math.max(30_000, ttlMs));
    this.sessions.set(handle, { signedUrl: url.toString(), expiresAt });
    return { handle, expiresAt: new Date(expiresAt).toISOString() };
  }

  claim(handle: string): string | undefined {
    const session = this.sessions.get(handle);
    this.sessions.delete(handle);
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return session.signedUrl;
  }
}

export interface ElevenLabsVoiceAgentOptions {
  apiKey: string;
  allowedAgentIds: string[];
  broker: EphemeralVoiceSessionBroker;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class ElevenLabsVoiceAgentSessionCapability implements CapabilityAdapter<VoiceAgentSessionArgs> {
  readonly manifest: CapabilityManifest;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, Record<string, unknown>>();

  constructor(private readonly options: ElevenLabsVoiceAgentOptions) {
    if (!options.apiKey.trim()) throw new Error('ElevenLabs API key is required.');
    if (!options.allowedAgentIds.length) throw new Error('At least one ElevenLabs agent ID must be allowlisted.');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.manifest = {
      id: 'media.voice.session.elevenlabs', version: '0.2.0',
      description: 'Create an approved, short-lived ElevenLabs voice-agent connection handle.',
      effects: ['network.request'], requiredEffects: ['network.request'],
      targetPatterns: options.allowedAgentIds.map(id => `voice://elevenlabs/${id}`),
      riskCeiling: 4, approval: 'always', idempotent: false, verification: 'required',
      inputSchema: {
        type: 'object', required: ['agentId'],
        properties: { agentId: { type: 'string', enum: [...options.allowedAgentIds] }, branchId: { type: 'string' }, environment: { type: 'string' } },
        additionalProperties: false,
      },
    };
  }

  async execute(proposal: ActionProposal<VoiceAgentSessionArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    try {
      if (!this.options.allowedAgentIds.includes(proposal.args.agentId)) throw new Error('The ElevenLabs agent ID is not allowlisted.');
      if (proposal.target !== `voice://elevenlabs/${proposal.args.agentId}`) throw new Error('Voice target and agent ID do not match.');
      const url = new URL('/v1/convai/conversation/get-signed-url', this.options.baseUrl ?? 'https://api.elevenlabs.io');
      url.searchParams.set('agent_id', proposal.args.agentId);
      url.searchParams.set('include_conversation_id', 'true');
      const branchId = cleanString(proposal.args.branchId, 200);
      const environment = cleanString(proposal.args.environment, 100);
      if (branchId) url.searchParams.set('branch_id', branchId);
      if (environment) url.searchParams.set('environment', environment);
      const response = await this.fetchImpl(url, { method: 'GET', headers: { 'xi-api-key': this.options.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
      const body = await responseJson(response, 100_000);
      const signedUrl = cleanString(body.signed_url, 10_000);
      if (!signedUrl) throw new Error('ElevenLabs returned no signed voice-agent URL.');
      const issued = this.options.broker.issue(signedUrl);
      const observation = { provider: 'elevenlabs', agentId: proposal.args.agentId, sessionHandle: issued.handle, expiresAt: issued.expiresAt, claimPath: `/api/media/voice-sessions/${issued.handle}/claim`, signedUrlPersisted: false };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: 'Created a one-time ElevenLabs voice-agent session handle; the signed URL was not persisted.', evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }] };
    } catch (error) {
      return executionFailure(error, 'ELEVENLABS_VOICE_SESSION_FAILED');
    }
  }

  async observe(proposal: ActionProposal<VoiceAgentSessionArgs>): Promise<Observation> {
    const value = this.observations.get(proposal.id);
    return { target: proposal.target, exists: !!value, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { missing: true }) }] };
  }

  async verify(_proposal: ActionProposal<VoiceAgentSessionArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'EPHEMERAL_VOICE_SESSION_HANDLE_OBSERVED', 'VOICE_SESSION_NOT_OBSERVED');
  }
}

export interface VisionProviderOptions extends SharedProviderOptions {
  provider?: string;
}

export class OpenAiCompatibleVisionCapability implements CapabilityAdapter<VisionAnalysisArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.image.analyze', version: '0.2.0',
    description: 'Analyze a bounded workspace image with a configured multimodal model.',
    effects: ['state.read', 'network.request'], requiredEffects: ['state.read', 'network.request'],
    targetPatterns: ['workspace/**'], riskCeiling: 3, approval: 'always', idempotent: false, verification: 'required',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, detail: { type: 'string', enum: ['low', 'high', 'auto'] } }, additionalProperties: false },
  };
  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, VisionObservation>();

  constructor(root: string, private readonly options: VisionProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('Vision provider API key is required.');
    if (!options.baseUrl) throw new Error('Vision provider base URL is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<VisionAnalysisArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.read')) return executionFailure('The grant does not authorize image reads.', 'INVALID_GRANT');
    try {
      const prompt = cleanString(proposal.args.prompt, 20_000);
      if (!prompt) throw new Error('A vision prompt is required.');
      const input = await workspaceMedia(this.resolver, proposal.target, IMAGE_TYPES, this.options.maxInputBytes ?? 15_000_000);
      const response = await this.fetchImpl(`${this.options.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model: this.options.model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`, detail: proposal.args.detail ?? 'auto' } }] }] }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      const body = await responseJson(response, 4_000_000);
      const analysis = cleanString(body.choices?.[0]?.message?.content, 250_000);
      if (!analysis) throw new Error('Vision provider returned no analysis.');
      const observation: VisionObservation = { provider: this.options.provider ?? 'openai-compatible', model: this.options.model, input: { target: proposal.target, bytes: input.bytes.byteLength, mimeType: input.mimeType, sha256: input.sha256 }, analysis, semanticVerification: 'provider_response_only' };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `The vision model analyzed ${input.bytes.byteLength} bytes and returned ${analysis.length} characters.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: digest(observation) }] };
    } catch (error) {
      return executionFailure(error, 'VISION_ANALYSIS_FAILED');
    }
  }

  async observe(proposal: ActionProposal<VisionAnalysisArgs>): Promise<Observation> {
    const value = this.observations.get(proposal.id);
    return { target: proposal.target, exists: !!value, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { missing: true }) }] };
  }

  async verify(_proposal: ActionProposal<VisionAnalysisArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'VISION_PROVIDER_RESPONSE_OBSERVED', 'VISION_RESPONSE_NOT_OBSERVED');
  }
}

export interface ImageGenerationProviderOptions extends SharedProviderOptions {
  provider?: string;
}

export class OpenAiImageGenerationCapability implements CapabilityAdapter<ImageGenerationArgs> {
  readonly manifest: CapabilityManifest = {
    id: 'media.image.generate', version: '0.2.0',
    description: 'Generate a bounded workspace image artifact with the configured image model.',
    effects: ['network.request', 'state.write'], requiredEffects: ['network.request', 'state.write'],
    targetPatterns: ['workspace/**'], riskCeiling: 4, approval: 'always', idempotent: false, verification: 'required',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, size: { type: 'string' }, quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] } }, additionalProperties: false },
  };
  private readonly resolver: WorkspaceTargetResolver;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<string, GeneratedArtifactObservation>();

  constructor(root: string, private readonly options: ImageGenerationProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('Image provider API key is required.');
    if (!options.baseUrl) throw new Error('Image provider base URL is required.');
    this.resolver = new WorkspaceTargetResolver(root);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(proposal: ActionProposal<ImageGenerationArgs>, grant: CapabilityGrant): Promise<CapabilityExecution> {
    const invalid = validateGrant(proposal, grant, this.manifest, 'network.request');
    if (invalid) return invalid;
    if (!grant.effects.includes('state.write')) return executionFailure('The grant does not authorize image writes.', 'INVALID_GRANT');
    try {
      const prompt = cleanString(proposal.args.prompt, 32_000);
      if (!prompt) throw new Error('An image-generation prompt is required.');
      const extension = extname(proposal.target).toLowerCase();
      const outputFormat = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.webp' ? 'webp' : extension === '.png' ? 'png' : undefined;
      if (!outputFormat) throw new Error('Generated image target must end in .png, .jpg, .jpeg, or .webp.');
      const size = cleanString(proposal.args.size, 40) ?? '1024x1024';
      if (!/^\d{2,5}x\d{2,5}$/.test(size) && size !== 'auto') throw new Error('Image size must be WIDTHxHEIGHT or auto.');
      const response = await this.fetchImpl(`${this.options.baseUrl!.replace(/\/$/, '')}/images/generations`, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model: this.options.model, prompt, size, quality: proposal.args.quality ?? 'auto', output_format: outputFormat, response_format: 'b64_json', n: 1 }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
      const body = await responseJson(response, Math.ceil((this.options.maxOutputBytes ?? 25_000_000) * 1.5));
      const encoded = cleanString(body.data?.[0]?.b64_json, Math.ceil((this.options.maxOutputBytes ?? 25_000_000) * 1.4));
      if (!encoded) throw new Error('Image provider returned no inline image artifact. Remote image URLs are intentionally rejected.');
      const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
      if (!bytes.byteLength || bytes.byteLength > (this.options.maxOutputBytes ?? 25_000_000)) throw new Error('Generated image is empty or exceeds the configured byte limit.');
      if (!hasArtifactSignature(bytes, outputFormat)) throw new Error('Generated bytes do not match the requested image format.');
      await atomicWrite(this.resolver, proposal.target, bytes, proposal.id);
      const observation: GeneratedArtifactObservation = { provider: this.options.provider ?? 'openai', model: this.options.model, target: proposal.target, bytes: bytes.byteLength, mimeType: IMAGE_TYPES[extension]!, sha256: binaryDigest(bytes) };
      this.observations.set(proposal.id, observation);
      return { success: true, summary: `Generated ${bytes.byteLength} image bytes at ${proposal.target}.`, evidence: [{ id: `tool:${proposal.id}`, kind: 'tool_result', source: this.manifest.id, digest: observation.sha256 }] };
    } catch (error) {
      return executionFailure(error, 'IMAGE_GENERATION_FAILED');
    }
  }

  async observe(proposal: ActionProposal<ImageGenerationArgs>): Promise<Observation> {
    try {
      const expected = this.observations.get(proposal.id);
      const actual = await workspaceMedia(this.resolver, proposal.target, IMAGE_TYPES, this.options.maxOutputBytes ?? 25_000_000);
      const exists = !!expected && actual.sha256 === expected.sha256;
      const value = exists ? { ...expected, bytes: actual.bytes.byteLength, sha256: actual.sha256 } : undefined;
      return { target: proposal.target, exists, value, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest(value ?? { mismatch: true }) }] };
    } catch {
      return { target: proposal.target, exists: false, evidence: [{ id: `observation:${proposal.id}`, kind: 'observation', source: this.manifest.id, digest: digest({ missing: true }) }] };
    }
  }

  async verify(_proposal: ActionProposal<ImageGenerationArgs>, execution: CapabilityExecution, observation: Observation): Promise<VerificationResult> {
    return observedVerification(execution, observation, 'IMAGE_ARTIFACT_DIGEST_OBSERVED', 'IMAGE_ARTIFACT_NOT_VERIFIED');
  }
}

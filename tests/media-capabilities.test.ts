import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeepgramSpeechSynthesisCapability,
  DeepgramTranscriptionCapability,
  ElevenLabsSpeechSynthesisCapability,
  ElevenLabsTranscriptionCapability,
  ElevenLabsVoiceAgentSessionCapability,
  EphemeralVoiceSessionBroker,
  OpenAiCompatibleVisionCapability,
  OpenAiImageGenerationCapability,
  type ImageGenerationArgs,
  type SpeechSynthesisArgs,
  type TranscriptionArgs,
  type VisionAnalysisArgs,
  type VoiceAgentSessionArgs,
} from '@hyper/capabilities';
import type { ActionProposal, CapabilityAdapter, CapabilityGrant, Effect } from '@hyper/contracts';

const roots: string[] = [];

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), 'hyper-media-test-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invocation<Args extends Record<string, unknown>>(
  capability: CapabilityAdapter<Args>,
  id: string,
  target: string,
  effects: Effect[],
  args: Args,
): { proposal: ActionProposal<Args>; grant: CapabilityGrant } {
  const proposal: ActionProposal<Args> = {
    id,
    intentId: 'intent:media',
    principalId: 'agent:test',
    conditionIds: [],
    capabilityId: capability.manifest.id,
    target,
    declaredEffects: effects,
    risk: 3,
    expectedEvidence: ['media_observed'],
    idempotencyKey: `${id}:once`,
    args,
  };
  return {
    proposal,
    grant: {
      id: `grant:${id}`,
      proposalId: id,
      decisionId: `decision:${id}`,
      principalId: proposal.principalId,
      capabilityId: capability.manifest.id,
      target,
      effects,
      maxRisk: 4,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

describe('bounded media capabilities', () => {
  test('uses Deepgram STT and TTS without exposing credentials and verifies the output artifact', async () => {
    const root = workspace();
    writeFileSync(join(root, 'input.wav'), new Uint8Array([82, 73, 70, 70, 1, 2, 3]));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const provider = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return url.includes('/v1/listen')
        ? Response.json({ metadata: { request_id: 'dg-request' }, results: { channels: [{ alternatives: [{ transcript: 'hello runtime', confidence: 0.98 }], detected_language: 'en' }] } })
        : new Response(new Uint8Array([73, 68, 51, 4, 5, 6]), { headers: { 'content-type': 'audio/mpeg' } });
    };
    const stt = new DeepgramTranscriptionCapability(root, { apiKey: 'secret-dg', model: 'nova-3', fetchImpl: provider });
    const sttCall = invocation<TranscriptionArgs>(stt, 'proposal:dg-stt', 'workspace/input.wav', ['state.read', 'network.request'], { language: 'en' });
    const sttExecution = await stt.execute(sttCall.proposal, sttCall.grant);
    const sttObservation = await stt.observe(sttCall.proposal);
    expect(await stt.verify(sttCall.proposal, sttExecution, sttObservation)).toMatchObject({ passed: true, reasonCodes: ['TRANSCRIPT_PROVIDER_RESPONSE_OBSERVED'] });
    expect(sttObservation.value).toMatchObject({ transcript: 'hello runtime', semanticVerification: 'provider_response_only' });
    expect(JSON.stringify(sttObservation)).not.toContain('secret-dg');

    const tts = new DeepgramSpeechSynthesisCapability(root, { apiKey: 'secret-dg', model: 'aura-2-thalia-en', fetchImpl: provider });
    const ttsCall = invocation<SpeechSynthesisArgs>(tts, 'proposal:dg-tts', 'workspace/output.mp3', ['network.request', 'state.write'], { text: 'hello runtime' });
    const ttsExecution = await tts.execute(ttsCall.proposal, ttsCall.grant);
    const ttsObservation = await tts.observe(ttsCall.proposal);
    expect(await tts.verify(ttsCall.proposal, ttsExecution, ttsObservation)).toMatchObject({ passed: true, reasonCodes: ['AUDIO_ARTIFACT_DIGEST_OBSERVED'] });
    expect([...readFileSync(join(root, 'output.mp3'))]).toEqual([73, 68, 51, 4, 5, 6]);
    expect(requests).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/v1/listen?'), authorization: 'Token secret-dg' }),
      expect.objectContaining({ url: expect.stringContaining('/v1/speak?'), authorization: 'Token secret-dg' }),
    ]);
  });

  test('uses ElevenLabs Scribe and TTS contracts with server-side credentials', async () => {
    const root = workspace();
    writeFileSync(join(root, 'input.mp3'), new Uint8Array([73, 68, 51, 7, 8]));
    const requests: Array<{ url: string; key: string | null; body: unknown }> = [];
    const provider = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, key: new Headers(init?.headers).get('xi-api-key'), body: init?.body });
      return url.includes('/speech-to-text')
        ? Response.json({ text: 'eleven transcript', language_code: 'en', language_probability: 0.97 })
        : new Response(new Uint8Array([73, 68, 51, 10, 11]), { headers: { 'content-type': 'audio/mpeg' } });
    };
    const stt = new ElevenLabsTranscriptionCapability(root, { apiKey: 'secret-eleven', model: 'scribe_v2', fetchImpl: provider });
    const sttCall = invocation<TranscriptionArgs>(stt, 'proposal:el-stt', 'workspace/input.mp3', ['state.read', 'network.request'], { diarize: true });
    expect((await stt.execute(sttCall.proposal, sttCall.grant)).success).toBe(true);
    expect(await stt.observe(sttCall.proposal)).toMatchObject({ exists: true, value: { transcript: 'eleven transcript' } });
    expect(requests[0]?.body).toBeInstanceOf(FormData);

    const tts = new ElevenLabsSpeechSynthesisCapability(root, { apiKey: 'secret-eleven', model: 'eleven_flash_v2_5', voiceId: 'voice_123', fetchImpl: provider });
    const ttsCall = invocation<SpeechSynthesisArgs>(tts, 'proposal:el-tts', 'workspace/eleven.mp3', ['network.request', 'state.write'], { text: 'voice response' });
    const execution = await tts.execute(ttsCall.proposal, ttsCall.grant);
    const observation = await tts.observe(ttsCall.proposal);
    expect(await tts.verify(ttsCall.proposal, execution, observation)).toMatchObject({ passed: true });
    expect(requests.map(item => item.key)).toEqual(['secret-eleven', 'secret-eleven']);
    expect(requests[1]?.url).toContain('/v1/text-to-speech/voice_123');
    expect(JSON.stringify(observation)).not.toContain('secret-eleven');
  });

  test('keeps ElevenLabs signed URLs ephemeral and makes handles single-use', async () => {
    const broker = new EphemeralVoiceSessionBroker();
    const capability = new ElevenLabsVoiceAgentSessionCapability({
      apiKey: 'secret-eleven',
      allowedAgentIds: ['agent_fixture'],
      broker,
      fetchImpl: async () => Response.json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=ephemeral-secret' }),
    });
    const call = invocation<VoiceAgentSessionArgs>(capability, 'proposal:voice', 'voice://elevenlabs/agent_fixture', ['network.request'], { agentId: 'agent_fixture' });
    const execution = await capability.execute(call.proposal, call.grant);
    const observation = await capability.observe(call.proposal);
    expect(await capability.verify(call.proposal, execution, observation)).toMatchObject({ passed: true });
    expect(JSON.stringify(observation)).not.toContain('ephemeral-secret');
    const handle = (observation.value as { sessionHandle: string }).sessionHandle;
    expect(broker.claim(handle)).toContain('ephemeral-secret');
    expect(broker.claim(handle)).toBeUndefined();
  });

  test('analyzes local images and writes inline generated images with digest observation', async () => {
    const root = workspace();
    writeFileSync(join(root, 'input.png'), new Uint8Array([137, 80, 78, 71, 1, 2]));
    const generated = new Uint8Array([137, 80, 78, 71, 9, 8, 7]);
    const requests: Array<{ url: string; body: Record<string, any> }> = [];
    const provider = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      requests.push({ url, body });
      return url.endsWith('/chat/completions')
        ? Response.json({ choices: [{ message: { content: 'A small fixture image.' } }] })
        : Response.json({ data: [{ b64_json: Buffer.from(generated).toString('base64') }] });
    };
    const vision = new OpenAiCompatibleVisionCapability(root, { apiKey: 'vision-secret', baseUrl: 'https://vision.example/v1', model: 'vision-model', fetchImpl: provider });
    const visionCall = invocation<VisionAnalysisArgs>(vision, 'proposal:vision', 'workspace/input.png', ['state.read', 'network.request'], { prompt: 'Describe only what is visible.' });
    const visionExecution = await vision.execute(visionCall.proposal, visionCall.grant);
    const visionObservation = await vision.observe(visionCall.proposal);
    expect(await vision.verify(visionCall.proposal, visionExecution, visionObservation)).toMatchObject({ passed: true, reasonCodes: ['VISION_PROVIDER_RESPONSE_OBSERVED'] });
    expect(visionObservation.value).toMatchObject({ analysis: 'A small fixture image.', semanticVerification: 'provider_response_only' });
    expect(requests[0]?.body.messages[0].content[1].image_url.url).toStartWith('data:image/png;base64,');

    const image = new OpenAiImageGenerationCapability(root, { apiKey: 'image-secret', baseUrl: 'https://images.example/v1', model: 'gpt-image-2', fetchImpl: provider });
    const imageCall = invocation<ImageGenerationArgs>(image, 'proposal:image', 'workspace/generated.png', ['network.request', 'state.write'], { prompt: 'A clear blue square.', size: '1024x1024' });
    const imageExecution = await image.execute(imageCall.proposal, imageCall.grant);
    const imageObservation = await image.observe(imageCall.proposal);
    expect(await image.verify(imageCall.proposal, imageExecution, imageObservation)).toMatchObject({ passed: true, reasonCodes: ['IMAGE_ARTIFACT_DIGEST_OBSERVED'] });
    expect(new Uint8Array(readFileSync(join(root, 'generated.png')))).toEqual(generated);
    expect(requests[1]?.body).toMatchObject({ response_format: 'b64_json', output_format: 'png', n: 1 });
  });
});

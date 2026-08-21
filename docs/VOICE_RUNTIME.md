# Realtime voice convergence

Status: bounded media adapters and secure session bootstrap exist; a complete
browser microphone-to-agent-to-speaker loop is not yet established.

## Product boundary

The useful target is not an imitation movie persona. It is a responsive,
interruptible agent surface whose spoken turns use the same session, authority,
tools, cancellation, evidence, and receipts as text chat:

```text
authenticated voice session
  -> packetized audio input
  -> partial/final transcript
  -> turn arbitration and barge-in
  -> ordinary Hyper conversation or workflow lane
  -> sentence-bounded response stream
  -> packetized audio output
  -> latency, cancellation, and outcome receipt
```

ElevenLabs and Deepgram can each provide a managed end-to-end voice loop, or
Hyper can compose their STT and TTS services around its own model/runtime. The
managed path is the fastest product path. The composed path provides more
provider portability and runtime control but has more failure boundaries.

Current provider guidance:

- [ElevenLabs Speech Engine](https://elevenlabs.io/docs/overview/capabilities/speech-engine)
  sends transcripts to the application's LLM endpoint and streams responses
  back for speech. Its event IDs define a useful cancellation rule: a newer
  user turn invalidates output for the older turn.
- [ElevenLabs realtime TTS](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
  supports incremental text, flush boundaries, alignment, and keepalives.
- [Deepgram Voice Agent](https://developers.deepgram.com/docs/build-a-voice-agent)
  exposes the full listen/think/speak loop over one WebSocket. Its event flow
  includes `UserStartedSpeaking`, which should stop playback immediately.
- [Deepgram token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)
  provides short-lived browser credentials without exposing a project API key.

Provider documentation motivates this design; configured live runs are still
required before making latency, reliability, or quality claims.

## What exists

- bounded Deepgram and ElevenLabs file transcription;
- bounded Deepgram and ElevenLabs speech artifact generation with digest
  observation;
- allowlisted ElevenLabs private-agent session bootstrap through a one-time
  signed-URL handle;
- Deepgram temporary-token bootstrap through the same provider-neutral,
  one-time handle boundary;
- no long-lived provider secret in canonical events, capability observations,
  configuration responses, or browser claims;
- explicit approval and observed-handle verification before a realtime session
  can be claimed; and
- live media smoke experiments separated from deterministic tests.

## The 3 / 6 / 9 execution sequence

### 3 — foundation (current slice)

1. **Outcome-bound completion.** Bind evidence obligations to the capability or
   effect that actually crossed verification; a successful read cannot prove a
   code write or test run.
2. **Provider-neutral credential bootstrap.** Use one-time handles for
   ElevenLabs signed URLs and Deepgram temporary bearer tokens; never persist
   the underlying credential.
3. **Typed batch adapters.** Keep STT, TTS, and voice-session startup as distinct
   capabilities with bounded bytes, targets, timeouts, errors, observations,
   and verification.

### 6 — usable realtime product (next)

1. Add a provider-neutral `VoiceSession` and `VoiceTurn` state machine with
   monotonically increasing turn IDs.
2. Add browser microphone capture and audio playback with explicit permission,
   device, format, and reconnect states.
3. Implement barge-in: new speech aborts the prior model request and discards
   stale text/audio packets by turn ID.
4. Route final transcripts into the existing conversation/workflow classifier;
   voice must not become a policy bypass or a separate memory system.
5. Stream text at sentence/phrase boundaries into TTS, record time to transcript,
   first model token, first audio, and completed turn, and expose a compact
   diagnostics panel.
6. Add deterministic provider selection and failover only before output is
   committed; after partial speech, surface interruption and resume instead of
   silently replaying potentially duplicated audio.

### 9 — durable and scalable service (after live gates pass)

1. Define a versioned audio-packet envelope: session, turn, sequence, codec,
   sample rate, timestamp, finality, byte count, and digest. Do not put raw
   audio in the canonical ledger.
2. Add bounded jitter buffers, backpressure, packet-loss counters, and adaptive
   chunking; tune from measurements rather than copying a media company's
   internal transport.
3. Add wake-word or sound recognition as a separate, opt-in capability. Shazam-
   style acoustic fingerprinting solves recognition, not conversational turn
   handling, and must not be mixed into STT authority.
4. Persist only conversation state, provider-independent turn metadata, and
   artifact references; keep transient audio buffers ephemeral with declared
   retention.
5. Add multi-instance session ownership and resumable leases. Introduce Redis
   or another broker only when cross-process fan-out, presence, or lease
   recovery is required; canonical runtime events remain durable truth.
6. Add per-tenant concurrency, spend, duration, and memory-pressure admission
   with provider-aware limits and graceful degradation.
7. Add recorded, consented test corpora for accents, noise, long pauses,
   interruptions, multilingual turns, tool latency, and provider failure.
8. Gate release on time-to-first-audio, word error rate, turn accuracy,
   interruption latency, stale-audio leakage, task completion, cost, and
   reconnect success.
9. Add a polished accessibility path: live captions, keyboard/text fallback,
   transcript correction, playback controls, reduced motion, and clear
   recording/retention indicators.

## Fallback policy

```text
connection fails before any output
  -> try the next explicitly configured provider

partial transcript exists
  -> preserve it as provisional data; request confirmation or resume

partial agent speech was played
  -> interrupt and reconcile by turn ID; never replay invisibly

all voice providers fail
  -> retain the same session and continue in text with a specific limitation
```

The smallest next experiment is an in-browser Deepgram session using a
single-use token, with `UserStartedSpeaking` cancelling one in-flight Hyper
response and a recorded interruption-latency receipt.

/**
 * core/kernel.ts — RunKernel: the main orchestrator.
 *
 * CHANGED vs original:
 *   - Wires `capabilitiesFor()` in: `plan_pass`/`verify_pass` now actually
 *     skip for driver-grade models (`caps.driver`), matching kernel.py:415-425.
 *   - `rateLimitedAt` is now actually populated: the loop's `onRateLimit` hook
 *     (fired from a caught `RateLimitError`) calls back into the kernel, so
 *     `isInEconomyMode()` stops being permanently false. Matches
 *     kernel.py:531-560 (minus the full provider-fallback chain — see
 *     MIGRATION.md for how to layer that in if you want it).
 *   - Gate edits need NO extra handling here anymore: `gate.ts`'s `resolve()`
 *     now calls `packet.applyEdits()` directly on the live packet object
 *     before releasing the held promise, so `packet` already reflects the
 *     operator's edits by the time we reach `packet.toMessages()` below. We
 *     just re-log the packet for observability.
 *
 * Lifecycle:
 *   intake → context assembly → gate → plan → action/observe loop → verify → respond → memory commit
 *
 * Each stage is a separate module (planner.ts, loop.ts, verifier.ts) that
 * the kernel coordinates. This modular design allows swapping or extending
 * any stage independently.
 */

import type { RuntimeConfig } from '../types/config';
import type { InputEnvelope, RunResult } from '../types/messages';
import type { Store } from '../store/sqlite';
import type { EventStore, EventLog } from '../store/events';
import type { ContextAssembler } from '../context/assembler';
import type { TurnGate } from '../context/gate';
import type { ToolRegistry, ToolContext } from '../tools/registry';
import { buildProvider, type Provider, ProviderError, nextFallbackProvider } from '../providers/base';
// capabilities.ts lives at src/providers/capabilities.ts — adjust if your tree differs
import { capabilitiesFor } from './capabilities';
import { runPlanner, type Plan } from './planner';
import { runVerifier, runCompletionCheck, runDistiller } from './verifier';
import { runActionLoop, createLoopState, type LoopConfig } from './loop';
import { PacketTrail } from './packet';
import { computeAttribution } from './attribution';
import { evaluateScorecard } from './scorecard';
import { ActiveMappingEngine, type ExecutionPhase } from './active_mapping';
import { withRunContext } from './error-interceptor';
// NOTE: `../kernel/dlrs/kernel`'s `runDLRS` used to be imported here but was
// never called — it's a second, independent turn-execution engine with its
// own event vocabulary (`tool.called`/`tool.completed` vs. this file's
// `tool.call`/`tool.result`). Importing it unused is worse than not importing
// it: anything reading the event log has to guess which vocabulary it'll see.
// Either delete dlrs/kernel.ts, or explicitly branch `run()` on a config flag
// (e.g. `config.engine === 'dlrs'`) so only one engine is ever live per run.

export class RunKernel {
  private rateLimitedAt: Map<string, number> = new Map();
  private activeMapping = new ActiveMappingEngine();

  constructor(
    private config: RuntimeConfig,
    private store: Store,
    private eventStore: EventStore,
    private assembler: ContextAssembler,
    private gate: TurnGate,
    private registry: ToolRegistry,
    private depth: number = 0, // 0 = user-facing, 1 = sub-agent
  ) {}

  /**
   * Run a full turn: intake → context → gate → plan → loop → verify → commit.
   */
  async run(envelope: InputEnvelope): Promise<RunResult> {
    const log = this.eventStore.openLog(envelope.run_id);
    const started = performance.now();
    const sessionId = this.store.ensureSession(envelope.session_id, envelope.message);
    envelope.session_id = sessionId;
    this.store.startRun(envelope.run_id, sessionId, envelope.message);

    log.emit('run.start', this.envelopePayload(envelope), {
      summary: `turn in ${sessionId}: ${envelope.message.slice(0, 80)}`,
    });

    const end = (status: string, finalText = '', extra?: Record<string, unknown>): RunResult => {
      this.store.finishRun(envelope.run_id, status, finalText);
      log.emit('run.end', {
        status,
        duration_ms: Math.round((performance.now() - started) * 10) / 10,
        ...extra,
      }, { summary: `run ${status}` });
      return { run_id: envelope.run_id, status: status as RunResult['status'], final_text: finalText };
    };

    try {
      // Tags any error captured by error-interceptor.ts's global handlers
      // with this run's id, so concurrent runs don't clobber each other's
      // captured error (see error-interceptor.ts for why this matters).
      return await withRunContext(envelope.run_id, () => this.runInner(envelope, sessionId, log, end));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return end('cancelled', '', { reason: 'stopped by user' });
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.emit('run.error', { error: msg }, { summary: `kernel crashed: ${msg}` });
      return end('failed');
    }
  }

  private async runInner(
    envelope: InputEnvelope,
    sessionId: string,
    log: EventLog,
    end: (status: string, text?: string, extra?: Record<string, unknown>) => RunResult,
  ): Promise<RunResult> {
    // ---- Context assembly ----
    const packet = this.assembler.assemble(envelope);

    for (const item of packet.items) {
      log.emit('context.item', {
        kind: item.kind,
        title: item.title,
        chars: item.chars,
        reason: item.reason,
      }, { summary: `[${item.kind}] ${item.title} (${item.chars} chars) — ${item.reason}` });
    }

    log.emit('context.packet', {
      mode: packet.mode,
      items: packet.includedItems().length,
      total_items: packet.items.length,
      total_chars: packet.total_chars,
    }, {
      summary: `packet [${packet.mode}]: ${packet.includedItems().length}/${packet.items.length} items, ${packet.total_chars} chars`,
    });

    this.store.appendMessage(sessionId, 'user', envelope.message, envelope.run_id);

    // ---- Gate ----
    const gateActive = envelope.gate ?? this.config.gateMode === 'inspect';
    if (gateActive) {
      log.emit('gate.open', {}, {
        summary: 'gate open: awaiting user inspection of the exact packet',
      });
      const resolution = await this.gate.hold(envelope.run_id, packet, this.config.gateTimeoutS);
      log.emit('gate.resolved', resolution as unknown as Record<string, unknown>, {
        summary: `gate ${resolution.action}` + (resolution.diff.length ? `, ${resolution.diff.length} edit(s)` : ''),
      });
      if (resolution.action === 'cancelled') {
        return end('cancelled');
      }
      if (resolution.diff.length > 0) {
        log.emit('context.packet', {
          mode: packet.mode,
          items: packet.includedItems().length,
          total_items: packet.items.length,
          total_chars: packet.total_chars,
        }, {
          summary: `packet after gate edits: ${packet.includedItems().length}/${packet.items.length} items, ${packet.total_chars} chars`,
        });
      }
    }

    let currentProviderName = envelope.provider || this.config.provider;
    const triedProviders = new Set<string>();

    while (true) {
      // ---- Provider preflight ----
      let provider: Provider;
      try {
        provider = buildProvider(
          currentProviderName,
          envelope.model,
          this.config as unknown as Parameters<typeof buildProvider>[2],
        );
        triedProviders.add(provider.name);
      } catch (err) {
        if (err instanceof ProviderError) {
          const fallback = nextFallbackProvider(triedProviders, this.config.fallbackChain, this.config as any);
          if (fallback) {
            log.emit('provider.fallback', { from: currentProviderName, to: fallback.name, error: err.message }, { summary: `provider fallback: ${currentProviderName} -> ${fallback.name} (${err.message})` });
            currentProviderName = fallback.name;
            continue;
          }
          log.emit('run.error', { error: err.message }, { summary: `provider unavailable: ${err.message}` });
          return end('failed');
        }
        throw err;
      }

      // ---- Capability profile: gates plan/verify scaffolding below ----
      const caps = capabilitiesFor(provider.name, provider.model);
      log.emit('capability', caps as unknown as Record<string, unknown>, {
        summary: `model profile: ${caps.driver ? 'driver' : 'scaffolded'}`
          + (caps.reasoning ? ', reasoning' : '')
          + ` (${caps.source})`,
      });

      // ---- Tools ----
      const tools = this.registry.specs({ objective: envelope.message });
      const toolNames = tools.map(t => t.function.name);

      // ---- Economy mode (after rate limit) ----
      const economy = this.isInEconomyMode(provider.name);

      try {
        // ---- Plan (skipped for driver-grade models — they own their own loop) ----
        let plan: Plan | null = null;
        if (this.config.planPass && !caps.driver) {
          const planProvider = this.resolvePhaseProvider('plan', provider, log);
          plan = await runPlanner(planProvider, packet.toMessages(), toolNames, { economy });
          if (plan) {
            log.emit('plan.created', {
              strategy: plan.strategy,
              steps: plan.steps,
            }, {
              summary: `plan: ${plan.strategy} (${plan.steps.length} steps)`,
            });
          }
        }

        // ---- Action loop ----
        const toolCtx: ToolContext = {
          sessionId,
          runId: envelope.run_id,
          dataDir: this.config.dataDir,
          emit: (type, payload, summary) => log.emit(type as any, payload, { summary }),
          store: this.store,
          runSubAgent: async (p: string, m: string, obj: string) => {
            const subEnv = {
              ...envelope,
              run_id: 'sub-' + crypto.randomUUID(),
              session_id: sessionId, // was implicitly passed as a 2nd run() arg it doesn't accept
              message: obj,
              auto: false,
            };
            const subKernel = new RunKernel(
              this.config, this.store, this.eventStore, this.assembler, this.gate, this.registry,
              this.depth + 1, // mark as sub-agent so it doesn't recurse into commitMemory etc. at depth 0
            );
            const res = await subKernel.run(subEnv);
            // BUG FIXED: RunResult exposes `final_text`, not `text` — the old
            // code always fell through to '' regardless of the sub-run's output.
            return res.final_text || '';
          },
        };

        const loopConfig: LoopConfig = {
          maxSteps: this.config.maxSteps,
          maxContinuations: this.config.maxContinuations,
          maxAutoSteps: this.config.maxAutoSteps,
          maxConsecutiveToolFails: this.config.maxConsecutiveToolFails,
          maxTranscriptChars: this.config.maxTranscriptChars,
          stagnationOverlapThreshold: this.config.stagnationOverlapThreshold,
          stagnationMaxStrikes: this.config.stagnationMaxStrikes,
          verifyPass: this.config.verifyPass && !caps.driver && !economy,
          auto: envelope.auto,
          deltaPass: !!(this.config.deltaPass) && !caps.driver && !economy,
        };

        const trail = new PacketTrail(envelope.run_id);
        const goalPacket = trail.emit('goal', { message: envelope.message }, 'user objective');

        const state = createLoopState();

        const cStats = packet.compressionStats;
        if (cStats.notesDeduped > 0 || cStats.filesChunked > 0) {
          log.emit('context.compressed', {
            notes_deduped: cStats.notesDeduped,
            files_chunked: cStats.filesChunked,
          }, {
            summary: `context compression: ${cStats.notesDeduped} notes deduped, ${cStats.filesChunked} files chunked`,
          });
        }
        
        const outcome = await runActionLoop(
          provider,
          packet.toMessages(),
          tools as any,
          toolNames,
          this.registry,
          toolCtx,
          plan,
          log,
          loopConfig,
          state,
          envelope.message,
          trail,
          {
            onVerify: loopConfig.verifyPass
              ? async (draft) => runVerifier(
                  this.resolvePhaseProvider('verify', provider, log),
                  envelope.message, draft, state.toolEvidence,
                )
              : undefined,
            onCompletionCheck: envelope.auto
              ? async (draft) => runCompletionCheck(provider, envelope.message, draft)
              : undefined,
            onRateLimit: (providerName) => {
              this.rateLimitedAt.set(providerName, Date.now());
              log.emit('run.error', { rate_limited: true, provider: providerName }, {
                summary: `rate limited on ${providerName}; economy mode armed for ${this.config.economyCooldownS}s`,
              });
            },
          },
        );

        let finalOutcome = outcome;
        if (outcome.kind === 'reassemble') {
          log.emit('delta.reassemble.start', {
            reason: outcome.reason,
            has_new_plan: !!outcome.plan,
          }, { summary: `reassembling with fresh plan: ${outcome.reason}` });

          const reassembleState = createLoopState();
          const reassembleTrail = new PacketTrail(`${envelope.run_id}.r1`);
          reassembleTrail.emit('goal', { message: envelope.message, reassemble: true }, 'reassemble retry');

          finalOutcome = await runActionLoop(
            provider,
            packet.toMessages(),
            tools as any,
            toolNames,
            this.registry,
            toolCtx,
            outcome.plan,
            log,
            { ...loopConfig, deltaPass: false },
            reassembleState,
            envelope.message,
            reassembleTrail,
            {
              onVerify: loopConfig.verifyPass
                ? async (draft) => runVerifier(provider, envelope.message, draft, reassembleState.toolEvidence)
                : undefined,
              onCompletionCheck: envelope.auto
                ? async (draft) => runCompletionCheck(provider, envelope.message, draft)
                : undefined,
              onRateLimit: (providerName) => { this.rateLimitedAt.set(providerName, Date.now()); },
            },
          );

          reassembleState.usageTotal.input_tokens += state.usageTotal.input_tokens;
          reassembleState.usageTotal.output_tokens += state.usageTotal.output_tokens;
          Object.assign(state, reassembleState);
        }

        switch (finalOutcome.kind) {
          case 'reassemble':
            return end('failed');
          case 'cancelled':
            return end('cancelled');
          case 'failed':
            if (this.depth === 0) {
              this.store.appendMessage(sessionId, 'assistant',
                `(run failed — see trail ${envelope.run_id}; ask me to retry)`,
                envelope.run_id);
            }
            return end('failed');
          case 'complete': {
            const finalText = finalOutcome.kind === 'complete' ? finalOutcome.text : '';
            const degraded = finalOutcome.kind === 'complete' ? finalOutcome.degraded : false;

            log.emit('respond.final', {
              text: finalText,
              degraded,
              usage: state.usageTotal,
            }, { summary: `final answer: ${finalText.length} chars` });

            // ---- Attribution Tracking ----
            if (envelope.passes?.attribution !== false) {
              const attributionReport = computeAttribution(envelope.run_id, finalText, packet.items);
              log.emit('attribution.report' as any, attributionReport as any, {
                summary: `attribution: ${attributionReport.attributions.length} matched item(s)` +
                  (attributionReport.topContributor ? `, top: ${attributionReport.topContributor.title}` : ''),
              });
            }

            // ---- Scorecard Evaluation ----
            const scorecard = evaluateScorecard({
              runId: envelope.run_id,
              durationMs: state.elapsedMs || 1000,
              inputTokens: state.usageTotal.input_tokens,
              outputTokens: state.usageTotal.output_tokens,
              // FIXED: was hardcoded to [] regardless of what actually
              // happened in the loop, so any scorecard dimension keyed off
              // tool usage/success rate was structurally always zero.
              // `state.toolCallLog` is populated in loop.ts at every real
              // execution, cache-hit, and missing-arg-failure site.
              toolCalls: state.toolCallLog,
            });
            log.emit('scorecard.report' as any, scorecard as any, {
              summary: `scorecard: Grade ${scorecard.rating} (${scorecard.score}/100)`,
            });

            this.store.appendMessage(sessionId, 'assistant', finalText, envelope.run_id);

            const shouldDistill = envelope.passes?.distill ?? (this.config.memoryExtraction && !economy && this.depth === 0);
            if (shouldDistill) {
              // Awareness thread: Run memory distillation in the background so it doesn't block the UI
              this.commitMemory(provider, sessionId, envelope, finalText, state, log).catch(err => {
                log.emit('run.error', { error: `Awareness thread failed: ${err.message}` }, { summary: 'awareness thread failure' });
              });
            }

            return end('complete', finalText, {
              degraded,
              usage: state.usageTotal,
              scorecard,
            });
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) {
          const fallback = nextFallbackProvider(triedProviders, this.config.fallbackChain, this.config as any);
          if (fallback) {
            log.emit('provider.fallback', { from: provider.name, to: fallback.name, error: err.message }, { summary: `provider fallback: ${provider.name} -> ${fallback.name} (${err.message})` });
            currentProviderName = fallback.name;
            continue;
          }
        }
        throw err;
      }
    }
  }

  /**
   * Memory commit: extract facts and update synopsis via the distiller.
   */
  private async commitMemory(
    provider: Provider,
    sessionId: string,
    envelope: InputEnvelope,
    finalText: string,
    state: ReturnType<typeof createLoopState>,
    log: EventLog,
  ): Promise<void> {
    try {
      const currentState = this.store.getSessionState(sessionId);
      const exchange = `User: ${envelope.message}\n\nAssistant: ${finalText}`;

      const result = await runDistiller(provider, currentState.synopsis, exchange);
      if (!result) return;

      const noteIds: string[] = [];
      for (const fact of result.facts) {
        if (fact.trim() && !this.store.noteDuplicateExists(sessionId, fact)) {
          const id = this.store.addNote(sessionId, envelope.run_id, 'fact', fact);
          noteIds.push(id);
        }
      }

      if (result.self_note?.trim() && !this.store.noteDuplicateExists(sessionId, result.self_note)) {
        const id = this.store.addNote(sessionId, envelope.run_id, 'lesson', result.self_note);
        noteIds.push(id);
      }

      this.store.setSessionState(sessionId, {
        synopsis: result.synopsis,
        topic: result.topic,
      });

      log.emit('memory.commit', {
        note_ids: noteIds,
        facts: result.facts,
        synopsis_length: result.synopsis.length,
        topic: result.topic,
        has_self_note: !!result.self_note,
      }, {
        summary: `memory: ${result.facts.length} fact(s), topic="${result.topic}", ${result.synopsis.length} char synopsis`,
      });
    } catch {
      // Memory extraction is never critical — skip silently
    }
  }

  /**
   * Resolve a phase-specific provider via ActiveMappingEngine (e.g. a cheap
   * model for planning, a stronger one for tool_loop/verify), previously
   * defined in active_mapping.ts but never called anywhere — every phase
   * used the single flat `provider` for the whole run regardless of what
   * ActiveMappingEngine recommended.
   *
   * Gated behind `config.activeModelMapping` (default off) because the
   * mapping table hardcodes specific provider/model strings that may not be
   * configured in every deployment — falls back to `fallback` on any
   * buildProvider error rather than failing the run.
   */
  private resolvePhaseProvider(
    phase: ExecutionPhase,
    fallback: Provider,
    log: EventLog,
    userOverrideProvider?: string,
    userOverrideModel?: string,
  ): Provider {
    if (!this.config.activeModelMapping) return fallback;
    const rule = this.activeMapping.resolveModelForPhase(phase, userOverrideProvider, userOverrideModel);
    try {
      const phaseProvider = buildProvider(rule.provider, rule.model, this.config as unknown as Parameters<typeof buildProvider>[2]);
      log.emit('active_mapping.routed', { phase, provider: rule.provider, model: rule.model, reason: rule.reason }, {
        summary: `phase '${phase}' routed to ${rule.provider}/${rule.model}: ${rule.reason}`,
      });
      return phaseProvider;
    } catch (err) {
      log.emit('active_mapping.fallback', {
        phase, attempted: `${rule.provider}/${rule.model}`,
        error: err instanceof Error ? err.message : String(err),
      }, { summary: `phase '${phase}' mapping unavailable, staying on ${fallback.name}/${fallback.model}` });
      return fallback;
    }
  }

  private isInEconomyMode(providerName: string): boolean {
    const lastLimited = this.rateLimitedAt.get(providerName);
    if (!lastLimited) return false;
    return (Date.now() - lastLimited) < this.config.economyCooldownS * 1000;
  }

  private envelopePayload(envelope: InputEnvelope): Record<string, unknown> {
    return {
      run_id: envelope.run_id,
      session_id: envelope.session_id,
      message: envelope.message.slice(0, 200),
      provider: envelope.provider,
      model: envelope.model,
      gate: envelope.gate,
      auto: envelope.auto,
      files: envelope.files.length,
      images: envelope.images.length,
    };
  }
}

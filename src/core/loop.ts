/**
 * core/loop.ts — The action/observation execution loop.
 *
 * CHANGED vs original:
 *   - `state.transcript` is now `Message[]` (providers/base). Tool calls push
 *     ONE assistant message carrying `tool_calls: [...]`, and each tool result
 *     pushes ONE `{role:'tool', tool_call_id, name, content}` message.
 *   - `streamTurn` calls are now wrapped with rate-limit-aware retry via
 *     `callModel()` — on a `RateLimitError`, `opts.onRateLimit` fires and
 *     the loop backs off before retrying the same step once.
 *   - **Delta engine wired in**: after the verifier/auto-check but BEFORE
 *     returning 'complete', `runDeltaCheck` assesses goal-vs-state distance.
 *     `decideCorrection` then forks:
 *       heal      → push an internal user message with a DIFFERENT next step
 *                   and `continue` (same plan, same loop — cheap, in-loop fix)
 *       reassemble → return `{ kind: 'reassemble', plan }` so the kernel can
 *                   restart the loop with a fresh plan instead of looping on
 *                   a broken transcript.
 *     A `PacketTrail` (core/packet.ts) is threaded through the loop so
 *     `decideCorrection` can call `trail.countSince('correction', 'delta')`
 *     and know when to escalate stalled→diverging rather than heal-looping.
 *
 * Design principles:
 *   - Each step is fully evented (model.request → model.response → tool.call → tool.result)
 *   - Circuit breaker: consecutive tool failures trigger early abort
 *   - Deduplication: identical tool calls serve cached results
 *   - Stagnation detection: repeated identical drafts in auto mode are caught
 *   - Hurdle resolution: unfinished plan steps and open failures prompt continuation
 */

import type { Provider, ToolSpec, Message } from '../providers/base';
import { RateLimitError } from '../providers/base';
import type { ModelTurn, ToolCallRequest } from '../types/messages';
import type { EventLog } from '../store/events';
import type { ToolRegistry, ToolContext, ToolResult } from '../tools/registry';
import type { Plan, PlanStep } from './planner';
import { updatePlanSteps, unfinishedSteps } from './planner';
import { runDeltaCheck } from './delta';
import { decideCorrection } from './reassembler';
import type { PacketTrail } from './packet';
import { extractToolResult } from '../context/compressor';
import { ContextDriftHealer } from './heal';
import { SelfSteeringContextEngine, type SSCPCommand } from '../protocols/sscp';
import type { ContextPacket } from '../context/assembler';

// ---- Configuration for the loop ----

export interface LoopConfig {
  maxSteps: number;
  maxContinuations: number;
  maxAutoSteps: number;
  maxConsecutiveToolFails: number;
  maxTranscriptChars: number;
  stagnationOverlapThreshold: number;
  stagnationMaxStrikes: number;
  verifyPass: boolean;
  auto: boolean;
  /**
   * Whether to run the delta engine (goal-vs-state check) on each draft.
   * Disabled in economy mode or when the model is driver-grade with its
   * own internal loop. Costs one lightweight provider call per draft.
   */
  deltaPass: boolean;
}

// ---- Loop state (mutable, tracks progress through the loop) ----

export interface LoopState {
  elapsedMs: number;
  transcript: Message[];
  toolEvidence: string[];
  finalText: string;
  continuations: number;
  autoSteps: number;
  revisions: number;
  consecutiveFails: number;
  stagnantStrikes: number;
  prevAutoDraft: string;
  degraded: boolean;
  usageTotal: { input_tokens: number; output_tokens: number };
  /**
   * Structured record of every tool invocation this run made (name + outcome +
   * whether it was served from cache). Previously nothing captured this in a
   * form other callers could consume, so `evaluateScorecard()` was always
   * called with `toolCalls: []` in kernel.ts regardless of actual usage.
   */
  toolCallLog: { name: string; success: boolean; cached: boolean }[];
}

export function createLoopState(): LoopState {
  return {
    transcript: [],
    toolEvidence: [],
    finalText: '',
    continuations: 0,
    autoSteps: 0,
    revisions: 0,
    consecutiveFails: 0,
    stagnantStrikes: 0,
    prevAutoDraft: '',
    degraded: false,
    usageTotal: { input_tokens: 0, output_tokens: 0 },
    toolCallLog: [],
    elapsedMs: 0,
  };
}

// ---- The loop result ----

export type LoopOutcome =
  | { kind: 'complete'; text: string; degraded: boolean }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string }
  | { kind: 'reassemble'; plan: Plan | null; reason: string };

// ---- Scrubbing: remove template leaks from model output ----

const TEMPLATE_FRAGMENTS = /<\/?(?:tool_call|arg_key|arg_value|tool_response)>[^<\n]*/gi;
const SPECIAL_TOKENS = /<\|[a-zA-Z0-9_./-]{1,40}\|>/g;

function scrubText(text: string): string {
  return text
    .replace(TEMPLATE_FRAGMENTS, '')
    .replace(SPECIAL_TOKENS, '')
    .trim();
}

// ---- Transcript trimming ----

function trimTranscript(transcript: Message[], maxChars: number): void {
  let totalChars = transcript.reduce((s, m) => s + m.content.length, 0);
  while (totalChars > maxChars && transcript.length > 2) {
    const removed = transcript.shift()!;
    totalChars -= removed.content.length;
  }
}

// ---- Text overlap for stagnation detection ----

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
}

function textOverlap(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 && wb.size === 0) return 0;
  const union = new Set([...wa, ...wb]);
  const intersection = new Set([...wa].filter(w => wb.has(w)));
  return intersection.size / union.size;
}

// ---- Missing arg fallbacks (Intelligent LLM Extraction) ----

/** Stable, key-order-independent stringification for cache/dedup signatures. */
function sortedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) out[k] = args[k];
  return out;
}

async function recoverMissingArgs(
  provider: Provider,
  missingFields: string[],
  objective: string,
  toolName: string,
): Promise<Record<string, string>> {
  const prompt = `You are an auto-recovery subsystem.
The main LLM dropped the following required arguments for the tool '${toolName}': ${missingFields.join(', ')}.
Analyze the user's original objective and extract the missing arguments.
Original objective: "${objective}"

Return STRICT JSON only. Format: {"args": {"field_name": "extracted_value"}}.
If a value cannot be found in the objective, omit it.`;

  try {
    const res = await provider.streamTurn([{ role: 'user', content: prompt }], [], () => Promise.resolve());
    // FIXED: was a raw greedy `/\{[\s\S]*\}/` match from the first `{` to the
    // LAST `}` in the whole response — breaks if the model wraps JSON in a
    // fenced code block or adds any trailing commentary containing braces.
    // Strip fences first, then take the first-to-last brace within that.
    const cleaned = (res.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gm, '');
    const start = cleaned.indexOf('{');
    const stop = cleaned.lastIndexOf('}');
    const jsonStr = start !== -1 && stop > start ? cleaned.slice(start, stop + 1) : '{}';
    const parsed = JSON.parse(jsonStr);
    return parsed.args || {};
  } catch {
    return {};
  }
}

// ---- Rate-limit-aware model call ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(
  provider: Provider,
  messages: Message[],
  tools: ToolSpec[],
  onDelta: (text: string) => Promise<void>,
  onReasoning: ((text: string) => Promise<void>) | undefined,
  onRateLimit: ((providerName: string) => void) | undefined,
): Promise<ModelTurn> {
  try {
    return await provider.streamTurn(messages, tools, onDelta, onReasoning);
  } catch (err) {
    if (err instanceof RateLimitError) {
      onRateLimit?.(provider.name);
      const waitS = Math.min(err.retryAfter ?? 10, 30);
      await sleep(waitS * 1000);
      // one retry after backing off — mirrors kernel.py's single-retry pattern
      return await provider.streamTurn(messages, tools, onDelta, onReasoning);
    }
    throw err;
  }
}

// ---- The main execution loop ----

export async function runActionLoop(
  provider: Provider,
  packet: ContextPacket,
  tools: ToolSpec[],
  toolNames: string[],
  registry: ToolRegistry,
  toolCtx: ToolContext,
  plan: Plan | null,
  log: EventLog,
  config: LoopConfig,
  state: LoopState,
  objective: string,
  trail: PacketTrail,
  opts?: {
    onVerify?: (draft: string) => Promise<{ verdict: string; reason: string; instruction: string }>;
    onCompletionCheck?: (draft: string) => Promise<{ done: boolean; next?: string }>;
    /** Called whenever a RateLimitError is observed, so the kernel can arm economy mode. */
    onRateLimit?: (providerName: string) => void;
  },
): Promise<LoopOutcome> {
  const failedSignatures = new Map<string, number>();
  const succeededResults = new Map<string, string>();

  for (let step = 1; step <= config.maxSteps; step++) {
    trimTranscript(state.transcript, config.maxTranscriptChars);

    const messages: Message[] = [...packet.toMessages(), ...state.transcript];

    const activeTools = tools.filter(t => (failedSignatures.get(t.function.name) || 0) < config.maxConsecutiveToolFails);

    const requestEvent = log.emit('model.request', provider.requestDescriptor(messages, activeTools), {
      summary: `step ${step}: ${provider.name}/${provider.model}, ${messages.length} msgs, ${activeTools.length} tools`,
    });

    let turn: ModelTurn;
    try {
      const deltaBuf: string[] = [];
      turn = await callModel(
        provider,
        messages,
        activeTools,
        async (text) => {
          deltaBuf.push(text);
          const cleaned = scrubText(deltaBuf.join(''));
          if (cleaned.length > 40) {
            const emit = cleaned.slice(0, -40);
            deltaBuf.length = 0;
            deltaBuf.push(cleaned.slice(-40));
            log.emit('model.delta', { text: emit }, { summary: '', persist: false, parent_id: requestEvent.id });
          }
        },
        undefined,
        opts?.onRateLimit,
      );

      const tail = scrubText(deltaBuf.join(''));
      if (tail) {
        log.emit('model.delta', { text: tail }, { summary: '', persist: false, parent_id: requestEvent.id });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.emit('run.error', { error: msg, step, retrying: false }, {
        summary: `model call failed at step ${step}: ${msg}`,
      });
      return { kind: 'failed', reason: msg };
    }

    turn.text = scrubText(turn.text || '');
    state.usageTotal.input_tokens += turn.usage.input_tokens;
    state.usageTotal.output_tokens += turn.usage.output_tokens;

    log.emit('model.response', {
      step,
      stop_reason: turn.stop_reason,
      text: turn.text,
      tool_calls: turn.tool_calls.map(t => ({ id: t.id, name: t.name, args: t.args })),
      usage: turn.usage,
    }, {
      summary: `step ${step}: ${turn.stop_reason}`
        + (turn.tool_calls.length ? `, ${turn.tool_calls.length} tool call(s)` : `, ${turn.text.length} chars`),
      parent_id: requestEvent.id,
    });

    // ---- No tool calls = draft answer ----
    if (turn.tool_calls.length === 0) {
      const draft = turn.text;

      if (plan && state.continuations < config.maxContinuations && step < config.maxSteps) {
        const unfinished = unfinishedSteps(plan);
        if (unfinished.length > 0) {
          state.continuations++;
          log.emit('loop.continue', {
            continuation: state.continuations,
            max: config.maxContinuations,
            unfinished_steps: unfinished,
          }, {
            summary: `continuation ${state.continuations}/${config.maxContinuations}: ${unfinished.length} unfinished step(s)`,
          });
          state.transcript.push({ role: 'assistant', content: draft });
          state.transcript.push({
            role: 'user',
            content: `[internal system note — do NOT mention this note to the user] `
              + `The request is not fully satisfied yet. Unfinished steps: `
              + unfinished.map(s => `step ${s.id}: ${s.description} (tool: ${s.tool})`).join(', ')
              + `. Complete the remaining work now.`,
          });
          continue;
        }
      }

      if (config.verifyPass && opts?.onVerify && state.revisions <= 1 && draft.trim() && step < config.maxSteps) {
        const verdict = await opts.onVerify(draft);
        log.emit('verify.verdict', { ...verdict, step }, {
          summary: `verifier: ${verdict.verdict}` + (verdict.reason ? ` — ${verdict.reason.slice(0, 90)}` : ''),
        });
        if (verdict.verdict === 'revise' && state.revisions === 0) {
          state.revisions++;
          state.transcript.push({ role: 'assistant', content: draft });
          state.transcript.push({
            role: 'user',
            content: `[internal verifier — do not mention this to the user] Revise the draft. `
              + `Problem: ${verdict.reason}. ${verdict.instruction} `
              + `Reply with only the improved final answer, naturally written.`,
          });
          continue;
        }
      }

      if (config.auto && opts?.onCompletionCheck && state.autoSteps < config.maxAutoSteps && draft.trim() && step < config.maxSteps - 1) {
        const overlap = textOverlap(state.prevAutoDraft, draft);
        if (state.prevAutoDraft && overlap >= config.stagnationOverlapThreshold) {
          state.stagnantStrikes++;
          if (state.stagnantStrikes >= config.stagnationMaxStrikes) {
            log.emit('loop.continue', {
              kind: 'auto_stagnant', overlap: Math.round(overlap * 1000) / 1000,
              strikes: state.stagnantStrikes,
            }, { summary: `auto mode stagnant (${Math.round(overlap * 100)}% same) — stopping` });
            state.finalText = draft;
            return { kind: 'complete', text: draft, degraded: false };
          }
        }
        state.prevAutoDraft = draft;

        const check = await opts.onCompletionCheck(draft);
        if (!check.done && check.next) {
          state.autoSteps++;
          log.emit('loop.continue', {
            kind: 'auto', continuation: state.autoSteps, max: config.maxAutoSteps,
            next: check.next,
          }, { summary: `auto step ${state.autoSteps}/${config.maxAutoSteps}: ${check.next.slice(0, 90)}` });
          state.transcript.push({ role: 'assistant', content: draft });
          state.transcript.push({
            role: 'user',
            content: `[autonomous mode — internal] The objective is not fully done. `
              + `Take this next action now: ${check.next}\n`
              + `When complete, give one clean final answer.`,
          });
          continue;
        }
      }

      // ---- Delta check: goal-vs-state, heal or reassemble ----
      // Runs AFTER plan/verify/auto-check so only genuinely-terminal drafts
      // reach it. Only fires when deltaPass is enabled AND we still have steps
      // left (so we don't waste a call if we're at the last step).
      if (config.deltaPass && step < config.maxSteps && draft.trim()) {
        let deltaPacket = trail.last('delta');

        const assessment = await runDeltaCheck(
          provider,
          objective,
          draft,
          state.toolEvidence,
          // Pass up to the last 5 transcript turns as recent-action history
          state.transcript.slice(-5).map(m =>
            m.role === 'assistant'
              ? (m.tool_calls?.length
                  ? `called: ${m.tool_calls.map(t => t.name).join(', ')}`
                  : `drafted: ${m.content.slice(0, 80)}`)
              : '',
          ).filter(Boolean),
        );

        deltaPacket = trail.emit('delta', assessment,
          `distance=${assessment.distance} risk=${assessment.risk}`,
          deltaPacket ?? null,
        );

        log.emit('delta.assessment', {
          distance: assessment.distance,
          risk: assessment.risk,
          missing: assessment.missing,
          next_action: assessment.next_action,
          step,
        }, {
          summary: `delta: distance=${assessment.distance}, risk=${assessment.risk}`
            + (assessment.missing.length ? `, missing: ${assessment.missing.join('; ')}` : ''),
        });

        if (assessment.risk !== 'ok' && assessment.distance !== 'none') {
          const correction = await decideCorrection(
            provider,
            assessment,
            objective,
            toolNames,
            trail,
            deltaPacket.id,
          );

          if (correction) {
            trail.emit('correction', correction, correction.kind, deltaPacket);

            if (correction.kind === 'heal') {
              log.emit('delta.heal', {
                instruction: correction.instruction.slice(0, 200),
                heals_so_far: trail.countSince('correction', 'delta'),
              }, { summary: `delta heal: injecting different next step` });
              state.transcript.push({ role: 'assistant', content: draft });
              state.transcript.push({ role: 'user', content: correction.instruction });
              continue;
            }

            if (correction.kind === 'reassemble') {
              log.emit('delta.reassemble', {
                reason: correction.reason,
                has_new_plan: !!correction.plan,
              }, { summary: `delta reassemble: ${correction.reason}` });
              return { kind: 'reassemble', plan: correction.plan, reason: correction.reason };
            }
          }
        }
      }

      state.finalText = draft;
      return { kind: 'complete', text: draft, degraded: false };
    }

    // ---- Execute tool calls ----
    // ONE assistant message records every tool call this step invoked, with
    // its real id/name/args — this is what the model sees echoed back to it
    // on the next step (previously discarded entirely).
      // SSCP Protocol Interception
      if (turn.text.includes('sscp:')) {
        const sscpEngine = new SelfSteeringContextEngine();
        const cmdMatch = turn.text.match(/sscp:(pin|shed|freeze|summarize)/);
        if (cmdMatch) {
          const action = cmdMatch[1] as any;
          const sscpRes = sscpEngine.executeCommand({ action, reason: 'model requested' } as SSCPCommand, packet.items);
          log.emit('sscp.command' as any, sscpRes as any, { summary: sscpRes.logSummary });
        }
      }

    state.transcript.push({
      role: 'assistant',
      content: turn.text,
      tool_calls: turn.tool_calls.map(t => ({ id: t.id, name: t.name, args: t.args })),
    });

    await Promise.all(turn.tool_calls.map(async (call) => {
      const pushToolResult = (content: string) => {
        state.transcript.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
      };

      // Missing required args check & intelligent LLM fallback
      let missing = registry.missingRequired(call.name, call.args);

      if (missing.length > 0) {
        log.emit('tool.call', { name: call.name, args: call.args, error: 'attempting auto-recovery' }, {
          summary: `tool ${call.name}: missing args ${missing.join(', ')} (attempting LLM auto-recovery)`,
        });

        const recoveredArgs = await recoverMissingArgs(provider, missing, objective, call.name);

        let filledSomething = false;
        for (const [k, v] of Object.entries(recoveredArgs)) {
          if (v) {
            call.args[k] = v;
            filledSomething = true;
          }
        }

        if (filledSomething) {
          missing = registry.missingRequired(call.name, call.args);
        }
      }

      if (missing.length > 0) {
        const errMsg = `Missing required argument(s): ${missing.join(', ')}`;
        log.emit('tool.call', { name: call.name, args: call.args, error: errMsg }, {
          summary: `tool ${call.name}: missing args ${missing.join(', ')}`,
        });
        pushToolResult(`TOOL ERROR (${call.name}): ${errMsg}. Provide the missing argument(s) and try again.`);
        state.toolCallLog.push({ name: call.name, success: false, cached: false });

        const fails = (failedSignatures.get(call.name) || 0) + 1;
        failedSignatures.set(call.name, fails);
        if (fails >= config.maxConsecutiveToolFails) {
          log.emit('tool.circuit_breaker', { name: call.name, fails, scope: 'per_tool' }, {
            summary: `per-tool circuit breaker tripped: ${call.name} disabled after ${fails} consecutive missing-argument failures`,
          });
          
          const healer = new ContextDriftHealer();
          const healRes = healer.healContext([], errMsg);
          if (healRes.healed) {
            pushToolResult(`SYSTEM HEAL: ${healRes.logSummary} Please try another tool or approach.`);
            return;
          }
        }
        return;
      }

      // Deduplication
      // FIXED: JSON.stringify(call.args) is key-order-dependent, so two
      // semantically identical calls with keys serialized in a different
      // order used to miss the cache. Sorting keys first makes the sig
      // order-independent.
      const sig = `${call.name}:${JSON.stringify(sortedArgs(call.args))}`;
      const cached = succeededResults.get(sig);
      if (cached !== undefined) {
        // Surface 2: compressed cached results still go through extraction
        // so the model gets a salient slice even if the original was huge.
        const cachedContent = extractToolResult(cached, objective);
        log.emit('tool.result', {
          name: call.name, cached: true, content: cachedContent.slice(0, 200),
          compressed: cachedContent.length < cached.length,
        }, { summary: `tool ${call.name}: served from cache` });
        state.toolCallLog.push({ name: call.name, success: true, cached: true });
        pushToolResult(cachedContent);
        return;
      }

      // Execute
      log.emit('tool.call', { name: call.name, args: call.args }, {
        summary: `tool ${call.name}(${Object.keys(call.args).join(', ')})`,
      });

      const result: ToolResult = await registry.execute(call.name, call.args, toolCtx);

      log.emit('tool.result', {
        name: call.name,
        success: result.success,
        content: result.content.slice(0, 500),
        metadata: result.metadata,
      }, {
        summary: `tool ${call.name}: ${result.success ? 'ok' : 'FAILED'} (${result.content.length} chars)`,
      });

      if (plan) updatePlanSteps(plan, call.name, result.success);

      if (result.success) {
        state.consecutiveFails = 0;
        failedSignatures.delete(call.name);

        // Duplicate Tool Search Interceptor: detect duplicate content
        const isDuplicate = state.toolEvidence.some(ev => ev.trim().replace(/\s+/g, ' ') === result.content.trim().replace(/\s+/g, ' '));
        if (isDuplicate) {
          state.stagnantStrikes = (state.stagnantStrikes || 0) + 1;
          log.emit('tool.duplicate_intercepted' as any, { toolName: call.name, strikes: state.stagnantStrikes } as any, {
            summary: `duplicate tool result detected for ${call.name} (strike ${state.stagnantStrikes})`,
          });
          if (state.stagnantStrikes >= 2) {
            pushToolResult(`[RUNTIME INTERCEPTOR: Duplicate tool output detected twice. Tool economy set to 0. Stop web searching and synthesize final response immediately.]`);
            return;
          }
        }

        succeededResults.set(sig, result.content); // store raw; extract on use
        state.toolEvidence.push(result.content);   // evidence keeps raw for delta check
        state.toolCallLog.push({ name: call.name, success: true, cached: false });
        // Surface 2: extract salient content before transcript — keeps budget clean
        const transcriptContent = extractToolResult(result.content, objective);
        if (transcriptContent.length < result.content.length) {
          log.emit('tool.result.compressed', {
            name: call.name,
            original_chars: result.content.length,
            compressed_chars: transcriptContent.length,
          }, { summary: `tool ${call.name} result compressed: ${result.content.length} → ${transcriptContent.length} chars` });
        }
        pushToolResult(transcriptContent);
      } else {
        state.consecutiveFails++;
        state.toolCallLog.push({ name: call.name, success: false, cached: false });
        const fails = (failedSignatures.get(call.name) || 0) + 1;
        failedSignatures.set(call.name, fails);
        if (fails >= config.maxConsecutiveToolFails) {
          // scope:'per_tool' — this tool specifically is now filtered out of
          // activeTools for the rest of the run (see `tools.filter(...)` at
          // the top of the loop). Distinct from the scope:'global' breaker
          // below, which just nudges the model and keeps going. Previously
          // both used the same event name with no way to tell which kind of
          // trip happened from the trail alone.
          log.emit('tool.circuit_breaker', { name: call.name, fails, scope: 'per_tool' }, {
            summary: `per-tool circuit breaker tripped: ${call.name} disabled for the rest of this run after ${fails} consecutive failures`,
          });
        }

        if (state.consecutiveFails >= config.maxConsecutiveToolFails) {
          log.emit('run.error', {
            error: `Circuit breaker: ${state.consecutiveFails} consecutive tool failures`,
            step,
          }, { summary: `global circuit breaker tripped after ${state.consecutiveFails} consecutive failures across any tool` });
          state.transcript.push({
            role: 'user',
            content: `[internal] Multiple tool calls have failed consecutively. `
              + `Try a different approach or give the best answer you can with available information.`,
          });
          state.consecutiveFails = 0;
        }
        pushToolResult(`TOOL ERROR (${call.name}): ${result.content}`);
      }
    }));
  } // end for step loop

  if (state.toolEvidence.length > 0 && !state.finalText) {
    state.finalText = '(Max steps reached. Here is the collected evidence.)\n\n'
      + state.toolEvidence[state.toolEvidence.length - 1];
    state.degraded = true;
    return { kind: 'complete', text: state.finalText, degraded: true };
  }

  return { kind: 'failed', reason: 'Exhausted max steps without producing an answer' };
}
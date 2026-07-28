/**
 * core/projections.ts — Materialized Views Projections Engine.
 * Ported from python projections.py
 *
 * Projects raw trail events into live session activity, tool reliability,
 * and cost projection summaries.
 */

import type { TrailEvent } from '../types/events';

export interface ProjectedSessionActivity {
  totalEvents: number;
  totalModelTurns: number;
  totalToolCalls: number;
  totalToolFailures: number;
  toolSuccessRate: number;
  estimatedCostUsd: number;
}

export class ProjectionsEngine {
  projectSession(events: TrailEvent[]): ProjectedSessionActivity {
    let totalEvents = events.length;
    let totalModelTurns = 0;
    let totalToolCalls = 0;
    let totalToolFailures = 0;
    let tokensUsed = 0;

    for (const ev of events) {
      // FIXED: loop.ts emits both 'model.request' and 'model.response' per
      // step — both start with 'model.', so counting on that prefix doubled
      // totalModelTurns. Count completed turns only, and read tokens from
      // where they actually live: `payload.usage.{input,output}_tokens`, not
      // flat `payload.input_tokens` (which loop.ts never sets — this made
      // tokensUsed, and therefore estimatedCostUsd, always compute to 0).
      if (ev.type === 'model.response') {
        totalModelTurns++;
        const usage = (ev.payload as any)?.usage;
        if (usage?.input_tokens) tokensUsed += Number(usage.input_tokens);
        if (usage?.output_tokens) tokensUsed += Number(usage.output_tokens);
      }
      // FIXED: 'tool.call' is emitted at the moment of attempt and never
      // carries `success` (that only appears on 'tool.result', or as an
      // `error` string on 'tool.call' for the missing-args-failure path) —
      // so `payload?.success === false` on 'tool.call' could never be true,
      // and totalToolFailures was always 0.
      if (ev.type === 'tool.call') {
        totalToolCalls++;
        if ((ev.payload as any)?.error) totalToolFailures++;
      }
      if (ev.type === 'tool.result' && (ev.payload as any)?.success === false) {
        totalToolFailures++;
      }
    }

    const successRate = totalToolCalls > 0 ? ((totalToolCalls - totalToolFailures) / totalToolCalls) * 100 : 100;
    // NOTE: still a single blended rate, not per-model pricing — this repo
    // has no pricing table to draw from, so treat this as a rough order-of-
    // magnitude signal, not a billing-accurate figure. Swap in a real
    // provider/model -> $/M-token lookup when one exists.
    const estCost = (tokensUsed / 1_000_000) * 0.15;

    return {
      totalEvents,
      totalModelTurns,
      totalToolCalls,
      totalToolFailures,
      toolSuccessRate: Number(successRate.toFixed(2)),
      estimatedCostUsd: Number(estCost.toFixed(4)),
    };
  }
}

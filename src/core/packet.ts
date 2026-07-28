/**
 * core/packet.ts — the phased-packet primitive.
 *
 * Answers the design question directly: packets carry BOTH the current
 * payload AND provenance (what produced them, why, and a walkable chain back
 * to the goal). Without that, "Self Healer" and "Reassembler" are
 * indistinguishable from "try again" — a healer needs to know THIS is the
 * second attempt at the same sub-goal and what the first attempt's delta
 * assessment said, not just what the current state is.
 *
 * This is deliberately a thin, generic primitive — NOT a rewrite of the event
 * log. `EventLog` is the durable, replayable trail (what actually happened,
 * for humans/audit). `PacketTrail` is the in-memory reasoning chain for THIS
 * run (what phase produced what, for the runtime's own decisions). They
 * overlap in spirit but serve different consumers; a packet can (and should)
 * also get logged to EventLog by the caller if it's trail-worthy.
 */

export type Phase =
  | 'goal'        // the raw objective as handed to the kernel
  | 'awareness'   // "what's happening, what's missing, what state are we in"
  | 'context'     // the assembled context packet (existing ContextPacket)
  | 'decision'    // plan/decider output: next transition, tool, reasoning mode
  | 'capability'  // which tools/skills were surfaced for this decision
  | 'execution'   // one act/observe step (model turn + tool results)
  | 'verification'// did reality match expectation
  | 'delta'       // current vs desired state, distance + risk
  | 'correction'  // self-heal or reassemble action taken in response to delta
  | 'state';      // the updated state handed to the next iteration

export interface PhasePacket<T = unknown> {
  id: string;
  runId: string;
  phase: Phase;
  payload: T;
  /** id of the packet this one was produced from, or null for the first (goal) packet. */
  derivedFrom: string | null;
  /** short human/LLM-readable reason this packet exists / what changed since derivedFrom. */
  reason: string;
  createdAt: number;
}

let _seq = 0;
function nextId(runId: string): string {
  _seq += 1;
  return `${runId}.pkt${_seq.toString(36)}`;
}

/**
 * Per-run packet chain. Not persisted by itself — the kernel/loop feed
 * interesting packets into EventLog as they're created if they should show
 * up in the trail (most should, via `log.emit('packet', packet, {summary})`
 * or similar — wire that at call sites, this class stays storage-agnostic).
 */
export class PacketTrail {
  private packets: PhasePacket[] = [];

  constructor(private runId: string) {}

  emit<T>(phase: Phase, payload: T, reason: string, derivedFrom?: PhasePacket | string | null): PhasePacket<T> {
    const derivedId = typeof derivedFrom === 'string' ? derivedFrom : derivedFrom?.id ?? null;
    const packet: PhasePacket<T> = {
      id: nextId(this.runId),
      runId: this.runId,
      phase,
      payload,
      derivedFrom: derivedId,
      reason,
      createdAt: Date.now(),
    };
    this.packets.push(packet as PhasePacket);
    return packet;
  }

  /** All packets in creation order. */
  all(): PhasePacket[] {
    return [...this.packets];
  }

  /** Most recent packet of a given phase, if any. */
  last<T = unknown>(phase: Phase): PhasePacket<T> | undefined {
    for (let i = this.packets.length - 1; i >= 0; i--) {
      if (this.packets[i].phase === phase) return this.packets[i] as PhasePacket<T>;
    }
    return undefined;
  }

  /** Walk backwards from a packet to the goal packet, following derivedFrom. */
  lineage(packet: PhasePacket): PhasePacket[] {
    const byId = new Map(this.packets.map(p => [p.id, p]));
    const chain: PhasePacket[] = [packet];
    let cur = packet;
    while (cur.derivedFrom) {
      const parent = byId.get(cur.derivedFrom);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    return chain.reverse(); // goal-first
  }

  /**
   * How many times has THIS phase fired since the last packet of `sincePhase`
   * (or since the start of the run if none)? This is what lets a self-healer
   * tell "first attempt" from "third retry of the same thing" — count
   * 'correction' packets derived (transitively) from the same 'delta' packet.
   */
  countSince(phase: Phase, sincePhase: Phase): number {
    const marker = this.last(sincePhase);
    const markerIdx = marker ? this.packets.indexOf(marker) : -1;
    return this.packets.slice(markerIdx + 1).filter(p => p.phase === phase).length;
  }
}

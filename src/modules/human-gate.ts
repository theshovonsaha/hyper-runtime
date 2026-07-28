/**
 * modules/human-gate.ts — Standalone Pre-Inference Human-in-the-Loop Gate Service.
 *
 * Exposes pre-inference packet hold, inspection, and item diff editing as an
 * extractable standalone service.
 */

export { TurnGate } from '../context/gate';
export type { GateResolution } from '../context/gate';

/**
 * modules/context-assembler.ts — Standalone Context Engineering & Provenance Service.
 *
 * Can be imported into any external TypeScript / Node / Bun application to assemble
 * token-budgeted context packets with provenance metadata.
 */

export { ContextAssembler } from '../context/assembler';
export type { ContextPacket, ContextItem, PacketItem, GateEdit } from '../context/assembler';

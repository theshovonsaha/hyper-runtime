/**
 * hyper-runtime/src/modules/index.ts
 *
 * Barrel export of all modular edge services in Hyper-Runtime.
 * Enables zero-overhead enterprise adoption as standalone code components.
 */

export * from './context-assembler';
export * from './human-gate';
export * from './drift-healer';
export * from './branch-manager';
export * from './attribution-engine';
export * from './scorecard-evaluator';
export * from './provider-router';

// Breakthrough Emergent Patterns (P1-P6)
export { researchWorkspaceTool } from '../tools/super_tools';
export { ACPDispatcher } from '../acp/protocol';
export { generateImageTool } from '../tools/media';
export { renderTemplate, templateArgNames, slugify } from '../core/workflows';
export { Scheduler } from '../core/scheduler';
export { TeamKernel } from '../domain/team/kernel';
export { consumeLastCapturedError, renderErrorPage } from '../core/error-interceptor';

// Novel Next-Generation Protocols (SSCP, RFP, TTSP, DMCN)
export * from '../protocols';

// Mature Python Engine Bridges
export { stockFinanceTool } from '../tools/finance';
export { MCPClient } from '../mcp/client';
export { ProjectionsEngine } from '../core/projections';
export { EncryptedCredentialStore } from '../store/credentials';
export { OpenTelemetryExporter } from '../core/otel';

// Threaded Memory Network & Intent-Driven Dynamic Team Orchestration
export { ThreadedMemoryStore, MemoryTieringEngine } from '../memory';
export { DynamicTeamOrchestrator } from '../orchestration/team';

// Active Memory & Active Chat Model Mapping Engine
export { ActiveMappingEngine } from '../core/active_mapping';

// System Understanding & Environment Awareness Engines
export { UnderstandingLayer } from '../core/understanding';
export { AwarenessEngine } from '../core/awareness';

// Proactive Thinking & Deterministic Seed Selection Engine
export { ProactiveSeedEngine } from '../core/seed_engine';

// Unified ASCII Byte-Stream & Code AST Transformation Engine
export { AsciiTransformEngine } from '../core/ascii_transform';

// Distributed State Coordinator & Vector Memory Adapter
export { DistributedStateAdapter } from '../store/distributed';

// Native WebRTC Audio Streaming Engine & Container Sandbox Runner
export { WebRtcAudioEngine } from '../core/webrtc_audio';
export { ContainerSandboxRunner } from '../core/container_sandbox';

// Dynamic Research Context Auto-Shedder & Summarizer
export { ResearchContextShedder } from '../context/research_shedder';

// Dynamic Epistemic Posture (DEP) Engine
export { DynamicEpistemicPostureEngine } from '../core/dep';

// Proactive Self-Evolving Code Engine & Dynamic Tool Hot-Reloading
export { SelfEvolvingCodeEngine } from '../core/self_evolving';

// 80/20 Deterministic Runtime Optimization Engine
export { EightyTwentyDeterministicEngine } from '../core/eighty_twenty';

// Dynamic Intermediate Packet & Phase Reassembly Pipeline
export { DynamicIntermediatePacketPipeline } from '../context/intermediate_pipeline';

// 50/50 Dual-Engine Deterministic Execution Core
export { FiftyFiftyDualEngine } from '../core/fifty_fifty';

// Granular Diamond Memory Management & Emergent Tool Suite
export { GranularMemoryEngine } from '../memory/granular';

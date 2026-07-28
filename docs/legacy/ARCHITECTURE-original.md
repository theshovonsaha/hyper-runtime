# Legacy System Architecture & Edge Modules Guide

> Historical design document. It describes the pre-convergence prototype, not
> the evaluated public package architecture.

This document details the internal architecture, 8-lane context budgeting, edge modularity, and 4 novel protocols of **Hyper-Runtime**.

---

## 1. System Architecture Diagram

```
                              ┌─────────────────────────────┐
                              │  USER / CLIENT / ACP ENGINE │
                              └──────────────┬──────────────┘
                                             │ POST /api/chat
                                             ▼
                              ┌─────────────────────────────┐
                              │    8-Lane ContextAssembler  │
                              │ (Token Capping & Provenance)│
                              └──────────────┬──────────────┘
                                             │
                                             ▼
                              ┌─────────────────────────────┐
                              │      TurnGate (HITL Hold)   │
                              │ (Approve / Exclude / Edit)  │
                              └──────────────┬──────────────┘
                                             │
                                             ▼
                              ┌─────────────────────────────┐
                              │        HyperKernel          │
                              │  ┌───────────────────────┐  │
                              │  │  SSCP / RFP / DMCN    │  │
                              │  └───────────┬───────────┘  │
                              └──────────────┼──────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
          ┌─────────────────────────┐                 ┌─────────────────────────┐
          │     Provider Router     │                 │   ToolRegistry Sandbox  │
          │ (Anthropic/OpenAI/Gemini│                 │ (Builtins/Super Tools/  │
          │  Groq/Ollama/Fallback)  │                 │  Media / Finance / MCP) │
          └─────────────────────────┘                 └─────────────────────────┘
```

---

## 2. 8-Lane Priority Context Engineering (`ContextAssembler`)

`ContextAssembler` builds stateless, character-budgeted prompt packets (`ContextPacket`) across 8 priority lanes:

1. **System Prompt Lane**: Core agent identity and operating rules.
2. **Session Synopsis Lane**: Compressed summary of historic conversation turns.
3. **Awareness Lane**: Real-time environment metrics (time, system OS, working directory).
4. **Core Memory Lane**: Durable user facts and preferences.
5. **Retrieved Notes Lane**: Term-frequency scored notes (`search_notes`).
6. **Skills & Workflows Lane**: Active skill instructions and prompt templates.
7. **Attached Files Lane**: User-uploaded documents and data files (chunked to fit budget).
8. **Current User Turn Lane**: The current user request.

---

## 3. The 4 Novel Protocols

### 3.1 Self-Steering Context Protocol (SSCP / `src/protocols/sscp.ts`)
- Enables real-time bidirectional context window mutations (`pin`, `shed`, `freeze`, `summarize`).

### 3.2 Reactive Failover & Healing Protocol (RFP / `src/protocols/rfp.ts`)
- Manages state checkpoints (`RFPCheckpoint`), state rewinding on tool errors, and rate-limit fallback provider cycling.

### 3.3 Trajectory Tree Synthesis Protocol (TTSP / `src/protocols/ttsp.ts`)
- Manages multi-branch execution trees (`branchId`), evaluating quality scores and merging winning steps into a canonical master solution trail.

### 3.4 Dynamic Model Capability Negotiator (DMCN / `src/protocols/dmcn.ts`)
- Performs cold-start capability discovery on model endpoints, dynamically constructing runtime scaffolding rules (`Fluid Driver` vs `Scaffolded Worker`).

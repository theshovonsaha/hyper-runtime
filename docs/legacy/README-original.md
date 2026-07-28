# Legacy README: pre-convergence prototype

> Historical document preserved for provenance. Its production-grade and
> performance claims were not established by the current research benchmark.

# Hyper-Runtime

> **Production-Grade, Glass-Box AI Agent Engine & Multi-Protocol Execution Runtime**  
> *Synthesizing the best architectures of Bun Harness Runtime, Python Harness Trail, and Deterministic AI Kernel.*

---

## Key Features & Innovations

- **Fluid CoT Reasoning (Mode A)**: Single-pass execution leveraging native `<think>` chain-of-thought, reducing API calls by up to 80%.
- **8-Lane Context Engineering (`ContextAssembler`)**: Budgeted context assembly with provenance tracking across System, Synopsis, Core Memory, Notes, History, Files, and User Input.
- **Pre-Inference Human-in-the-Loop Gate (`TurnGate`)**: Holds execution before model inference to let operators review, exclude, or rewrite prompt items in real time.
- **Context Self-Healing (`ContextDriftHealer`)**: Automatically detects tool argument schema errors and memory drift, repairing parameters in-flight without crashing.
- **Trajectory Tree Branching (`BranchManager`)**: State tree forking and parallel branch synthesis from any turn in a parent run.
- **4 Novel Protocols**:
  1. `SSCP` — Self-Steering Context Protocol (real-time item pinning, shedding, freezing).
  2. `RFP` — Reactive Failover Protocol (state rewinding & rate-limit fallback circuit).
  3. `TTSP` — Trajectory Tree Synthesis Protocol (multi-branch fork & merge synthesis).
  4. `DMCN` — Dynamic Model Capability Negotiator (cold-start capability discovery).
- **Standalone Modular Exports & Microservices**: Import any edge service independently in TS or consume via `/api/v1/*` REST microservices.
- **Mature Python Bridges**:
  - `stock_finance`: Stock quote research & fundamental analysis.
  - `MCPClient`: Model Context Protocol JSON-RPC 2.0 client.
  - `ProjectionsEngine`: Materialized telemetry views.
  - `EncryptedCredentialStore`: AES-256 encrypted credential storage.
  - `OpenTelemetryExporter`: OTLP tracing spans.

---

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) (`v1.0.0` or higher) or Node.js (`v18+`)
- macOS, Linux, or Windows (WSL2)

### Installation & Execution

```bash
# 1. Install dependencies
cd hyper-runtime
bun install

# 2. Start local dev server (default port: 3000)
bun src/index.ts
```

Open your browser at `http://localhost:3000` to launch the React glassmorphism UI!

---

## Verification Test Suites

```bash
# 1. Core Kernel Verification
bun scripts/test_hyper_runtime.ts

# 2. Standalone Modular Exports Test
bun scripts/test_modular_exports.ts

# 3. Novel Protocols Verification
bun scripts/test_novel_protocols.ts

# 4. Real-World Penetration Test Suite
bun scripts/pen_test_suite.ts

# 5. Complex Multi-Phase Stress Test
bun scripts/complex_test_suite.ts

# 6. Chaos Engineering & Failure Injection Harness
bun scripts/chaos_adversarial_harness.ts
```

---

## Documentation Directory

- [SETUP_GUIDE.md](./SETUP_GUIDE.md) — Machine setup, prerequisites, environment variables, and security.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Deep architectural design, edge modules, 8-lane context, and 4 novel protocols.
- [API_REFERENCE.md](./API_REFERENCE.md) — Full REST API endpoints, microservices (`/api/v1/*`), SSE streaming, and ACP.
- [DATAFLOW_AND_STORAGE.md](./DATAFLOW_AND_STORAGE.md) — SQLite WAL schema, event streams, projections, and memory caching.
- [DEV_TOOLS.md](./DEV_TOOLS.md) — Self-development tools, test suites, penetration testing, and chaos engineering.

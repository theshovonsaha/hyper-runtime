# Legacy Setup & Machine Deployment Guide

> Historical setup document. Do not use it as production deployment guidance
> for the evaluated public packages.

This guide covers machine setup, environment configuration, self-secure operation, and production deployment for **Hyper-Runtime**.

---

## 1. System Prerequisites

| Requirement | Minimum Version | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **OS** | macOS 12+, Linux (Ubuntu 20.04+), Windows (WSL2) | macOS Apple Silicon / Linux x86_64 | Tested on macOS arm64 |
| **Runtime** | Bun `v1.0.0` or Node.js `v18.0.0` | Bun `v1.3.14+` | Uses `bun:sqlite` for native WAL speed |
| **Memory** | 512 MB RAM | 2 GB+ RAM | Zero-leak heap memory footprint |
| **Disk** | 100 MB | 1 GB+ | SQLite database & JSONL trail event storage |

---

## 2. Environment Configuration (`.env`)

Create a `.env` file in the project root:

```ini
# Runtime Server Port
PORT=3000

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-proj-xxx
GEMINI_API_KEY=AIzaSyXxx
OPENROUTER_API_KEY=sk-or-xxx
GROQ_API_KEY=gsk_xxx

# Local LLM Providers (Optional)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
LMSTUDIO_BASE_URL=http://localhost:1234/v1

# Security & Passphrase
CREDENTIAL_PASSPHRASE=hyper-runtime-super-secret-key-2026
```

---

## 3. Self-Secure Usage & Security Policies

1. **Sandboxed Shell & Math Execution**:
   - `run_shell` commands execute inside sandboxed child processes with standard input/output isolation.
   - `calculator` tool blocks keywords (`require`, `import`, `eval`, `process`, `Bun`, `Deno`) to prevent code injection.

2. **Pre-Inference Human Gating (`gate_mode: "inspect"`)**:
   - Enable pre-inference hold to inspect, modify, or reject context packets before dispatching to remote LLM APIs.

3. **AES-256 Encrypted Credential Storage**:
   - API keys stored in SQLite are encrypted using `aes-256-cbc` via `EncryptedCredentialStore`.

4. **Automatic Rate-Limit Circuit Breaking (`RFP`)**:
   - When HTTP 429 exceptions occur, `ReactiveFailoverEngine` automatically cycles to non-throttled provider tiers without exposing secrets in logs.

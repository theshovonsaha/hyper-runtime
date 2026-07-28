# Legacy Self-Development Tools & Test Harness Guide

> Historical test inventory. These scripts are not the release-confidence
> suite for the evaluated public packages.

This document describes the self-development tools, test suites, penetration testing harness, and chaos engineering tools built into **Hyper-Runtime**.

---

## 1. Test Suite Matrix

| Script Location | Purpose & Scope | Execution Command |
| :--- | :--- | :--- |
| `scripts/test_hyper_runtime.ts` | One-shot core kernel & scorecard verification. | `bun scripts/test_hyper_runtime.ts` |
| `scripts/test_modular_exports.ts` | Standalone enterprise module exports (`src/modules/`). | `bun scripts/test_modular_exports.ts` |
| `scripts/test_novel_protocols.ts` | 4 Novel Protocols (`SSCP`, `RFP`, `TTSP`, `DMCN`). | `bun scripts/test_novel_protocols.ts` |
| `scripts/pen_test_suite.ts` | Real-world penetration testing (sandbox, DoS, fuzzing). | `bun scripts/pen_test_suite.ts` |
| `scripts/complex_test_suite.ts` | Complex multi-phase stress testing (10-branch load). | `bun scripts/complex_test_suite.ts` |
| `scripts/chaos_adversarial_harness.ts` | Chaos engineering & failure injection harness. | `bun scripts/chaos_adversarial_harness.ts` |

---

## 2. Self-Development Utilities

### 1. One-Shot Master Test Runner
Run all verification suites in sequence:
```bash
bun scripts/test_hyper_runtime.ts && \
bun scripts/test_modular_exports.ts && \
bun scripts/test_novel_protocols.ts && \
bun scripts/pen_test_suite.ts && \
bun scripts/complex_test_suite.ts && \
bun scripts/chaos_adversarial_harness.ts
```

### 2. UI Asset Bundler (`scripts/copy_ui.cjs`)
Re-distribute Vite compiled frontend bundles into the runtime server:
```bash
node scripts/copy_ui.cjs
```

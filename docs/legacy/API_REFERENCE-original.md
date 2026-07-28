# Legacy API & Microservices Reference Guide

> Historical API document. These endpoints are not part of the evaluated
> public package surface.

This document provides complete API documentation for all REST endpoints, SSE streams, standalone microservices (`/api/v1/*`), and ACP protocols in **Hyper-Runtime**.

---

## 1. Primary Chat & SSE Endpoints

### `POST /api/chat`
Starts a streaming model turn or multi-step action loop over Server-Sent Events (SSE).

- **Request Body**:
  ```json
  {
    "message": "Calculate stock fundamentals for AAPL and write a summary.",
    "session_id": "optional-session-id",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet",
    "gate": false,
    "passes": {
      "plan": false,
      "verify": false,
      "think": true,
      "heal": true
    }
  }
  ```
- **Response**: `text/event-stream` emitting JSON events (`model.think`, `tool.call`, `tool.stage`, `tool.result`, `attribution.report`, `scorecard.report`).

---

## 2. Standalone Edge Microservices (`/api/v1/*`)

| Endpoint | Method | Service | Input Payload | Output Response |
| :--- | :--- | :--- | :--- | :--- |
| `/api/v1/heal/assess` | `POST` | Context Drift Healer | `{ items: [], last_error: string }` | `{ healed: bool, actionTaken: string }` |
| `/api/v1/branch/fork` | `POST` | Branch Manager | `{ parent_run_id: string, fork_at_turn: int }` | `{ branchId: string, parentRunId: string }` |
| `/api/v1/attribution/compute` | `POST` | Attribution Engine | `{ run_id: string, response_text: string, items: [] }` | `RunAttributionReport` |
| `/api/v1/scorecard/evaluate` | `POST` | Scorecard Evaluator | `{ durationMs: int, toolCalls: [] }` | `ScorecardMetrics` (Grade S/A/B/C/F) |

---

## 3. Human-in-the-Loop Gating APIs

- `GET /api/runs/:id/gate` — Returns held context packet items for operator review.
- `POST /api/runs/:id/gate` — Accepts `{ action: "approved" | "cancelled", edits: [] }` to resume or cancel execution.

---

## 4. Agent Control Protocol (ACP+) JSON-RPC

- Methods supported: `initialize`, `session/new`, `session/prompt`, `session/request_permission`, `session/request_context_review`.

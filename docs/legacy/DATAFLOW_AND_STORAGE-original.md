# Legacy Dataflow & Storage Architecture Guide

> Historical design document. The evaluated core uses the contracts and
> hash-chained ledger documented under `docs/`.

This document details the dataflow, database schemas, write-ahead logging (WAL), and event log persistence in **Hyper-Runtime**.

---

## 1. Storage Architecture

Hyper-Runtime uses `bun:sqlite` with Write-Ahead Logging (`PRAGMA journal_mode=WAL`) and foreign keys enabled (`PRAGMA foreign_keys=ON`) for high-throughput, low-latency state persistence.

### Database Tables Schema (`shovs_v2.db`)

```sql
-- 1. Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- 2. Messages
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role       TEXT,
  content    TEXT,
  run_id     TEXT,
  created_at TEXT
);

-- 3. Runs
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  message     TEXT,
  status      TEXT DEFAULT 'running',
  final_text  TEXT,
  started_at  TEXT,
  finished_at TEXT
);

-- 4. Trajectory Tree Branches
CREATE TABLE IF NOT EXISTS branches (
  branch_id     TEXT PRIMARY KEY,
  parent_run_id TEXT,
  fork_at_turn  INTEGER,
  created_at    TEXT,
  note          TEXT
);

-- 5. Persistent Memory Notes
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  run_id     TEXT,
  kind       TEXT,
  content    TEXT,
  created_at TEXT
);

-- 6. Telemetry & Quality Scores
CREATE TABLE IF NOT EXISTS scores (
  id         TEXT PRIMARY KEY,
  run_id     TEXT,
  name       TEXT,
  value      REAL,
  label      TEXT,
  source     TEXT,
  comment    TEXT,
  created_at TEXT
);
```

---

## 2. Event Log Persistence (`EventStore`)

- Trail events are appended to JSONL log files under `data/runs/<run_id>/trail.jsonl`.
- SSE clients subscribe via `EventStore.subscribe(run_id)`, receiving real-time event broadcasts without polling SQLite.

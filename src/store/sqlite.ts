/**
 * @module store/sqlite
 * Persistent storage layer for the Bun Harness Runtime.
 *
 * Uses `bun:sqlite` (WAL mode) for all state: sessions, messages, runs,
 * notes, schedules, custom tools, workflows, scores, and telemetry.
 *
 * Design notes:
 *  - Every query uses a **prepared statement** cached on first call for
 *    maximum throughput (bun:sqlite compiles statements to native code).
 *  - UUIDs are generated via `crypto.randomUUID()`.
 *  - Timestamps are ISO-8601 UTC strings.
 *  - The schema is created/migrated in `_migrate()` using IF NOT EXISTS
 *    so the constructor is safe to call repeatedly on the same DB file.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { nearDuplicate } from '../knowledge/textsim';

function bm25Rank(
  query: string,
  docs: Array<{ text: string; payload: any }>,
  k1 = 1.5,
  b = 0.75,
): Array<[number, any]> {
  const tokenize = (t: string) => (t || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || docs.length === 0) return [];

  const tokenized = docs.map((d) => tokenize(d.text));
  const n = docs.length;
  const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / n || 1.0;

  const df: Record<string, number> = {};
  for (const toks of tokenized) {
    for (const term of new Set(toks)) {
      if (queryTerms.has(term)) {
        df[term] = (df[term] || 0) + 1;
      }
    }
  }

  const scored: Array<[number, any]> = [];
  for (let i = 0; i < docs.length; i++) {
    const payload = docs[i].payload;
    const toks = tokenized[i];
    let score = 0.0;
    const length = toks.length || 1;

    const counts: Record<string, number> = {};
    for (const t of toks) {
      if (queryTerms.has(t)) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }

    for (const [term, tf] of Object.entries(counts)) {
      const termDf = df[term] || 0;
      const idf = Math.log(1 + (n - termDf + 0.5) / (termDf + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / avgLen));
    }

    if (score > 0) {
      scored.push([score, payload]);
    }
  }

  scored.sort((a, b) => b[0] - a[0]);
  return scored;
}

// ─── Exported row types ────────────────────────────────────────────────────

export interface Message {
  id: number;
  session_id: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface SessionState {
  synopsis: string;
  topic: string;
  core_memory: string;
}

export interface ToolReliabilityRow {
  tool: string;
  ok: number;
  fail: number;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export class Store {
  private db: Database;

  // ── Prepared-statement cache (lazy-init via getters) ──────────────────

  // Sessions
  private _stmtInsertSession?: ReturnType<Database['prepare']>;
  private _stmtUpdateSessionTime?: ReturnType<Database['prepare']>;
  private _stmtGetSession?: ReturnType<Database['prepare']>;
  private _stmtListSessions?: ReturnType<Database['prepare']>;

  // Messages
  private _stmtInsertMessage?: ReturnType<Database['prepare']>;
  private _stmtGetHistory?: ReturnType<Database['prepare']>;

  // Runs
  private _stmtInsertRun?: ReturnType<Database['prepare']>;
  private _stmtFinishRun?: ReturnType<Database['prepare']>;
  private _stmtListRuns?: ReturnType<Database['prepare']>;

  // Notes
  private _stmtInsertNote?: ReturnType<Database['prepare']>;
  private _stmtRecentNotes?: ReturnType<Database['prepare']>;
  private _stmtDeleteNote?: ReturnType<Database['prepare']>;

  // Session state
  private _stmtGetState?: ReturnType<Database['prepare']>;
  private _stmtUpsertState?: ReturnType<Database['prepare']>;

  // Schedules
  private _stmtInsertSchedule?: ReturnType<Database['prepare']>;
  private _stmtListSchedules?: ReturnType<Database['prepare']>;
  private _stmtSetScheduleEnabled?: ReturnType<Database['prepare']>;
  private _stmtDeleteSchedule?: ReturnType<Database['prepare']>;

  // Custom tools
  private _stmtListCustomTools?: ReturnType<Database['prepare']>;
  private _stmtSetCustomToolEnabled?: ReturnType<Database['prepare']>;
  private _stmtDeleteCustomTool?: ReturnType<Database['prepare']>;

  // Workflows
  private _stmtListWorkflows?: ReturnType<Database['prepare']>;
  private _stmtGetWorkflow?: ReturnType<Database['prepare']>;
  private _stmtDeleteWorkflow?: ReturnType<Database['prepare']>;
  private _stmtBumpWorkflowRuns?: ReturnType<Database['prepare']>;

  // Scores
  private _stmtInsertScore?: ReturnType<Database['prepare']>;
  private _stmtRunScores?: ReturnType<Database['prepare']>;

  // Telemetry
  private _stmtRecordToolOutcome?: ReturnType<Database['prepare']>;
  private _stmtToolReliability?: ReturnType<Database['prepare']>;
  private _stmtRecordProviderOutcome?: ReturnType<Database['prepare']>;

  // Tasks
  private _stmtInsertTask?: ReturnType<Database['prepare']>;

  // Wiki
  private _stmtInsertWikiEntry?: ReturnType<Database['prepare']>;
  private _stmtUpdateWikiEntry?: ReturnType<Database['prepare']>;
  private _stmtDeleteWikiEntry?: ReturnType<Database['prepare']>;
  private _stmtListWikiEntries?: ReturnType<Database['prepare']>;

  // ─────────────────────────────────────────────────────────────────────

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA foreign_keys=ON');
    this._migrate();
  }

  // ── Schema migration ─────────────────────────────────────────────────

  /**
   * Idempotent schema bootstrap. Every table uses IF NOT EXISTS so this
   * method is safe to run on every startup.
   */
  private _migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role       TEXT,
        content    TEXT,
        run_id     TEXT,
        created_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id          TEXT PRIMARY KEY,
        session_id  TEXT,
        message     TEXT,
        status      TEXT DEFAULT 'running',
        final_text  TEXT,
        started_at  TEXT,
        finished_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS branches (
        branch_id     TEXT PRIMARY KEY,
        parent_run_id TEXT,
        fork_at_turn  INTEGER,
        created_at    TEXT,
        note          TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        run_id     TEXT,
        kind       TEXT,
        content    TEXT,
        created_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_state (
        session_id  TEXT PRIMARY KEY,
        synopsis    TEXT DEFAULT '',
        topic       TEXT DEFAULT '',
        core_memory TEXT DEFAULT ''
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schedules (
        id         TEXT PRIMARY KEY,
        message    TEXT,
        every_s    INTEGER,
        provider   TEXT,
        session_id TEXT,
        enabled    INTEGER DEFAULT 1,
        last_run   TEXT,
        runs       INTEGER DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS custom_tools (
        name        TEXT PRIMARY KEY,
        description TEXT,
        url         TEXT,
        method      TEXT,
        headers     TEXT,
        query       TEXT,
        body        TEXT,
        enabled     INTEGER DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        slug            TEXT PRIMARY KEY,
        title           TEXT,
        description     TEXT,
        prompt_template TEXT,
        provider        TEXT,
        model           TEXT,
        arg_names       TEXT,
        enabled         INTEGER DEFAULT 1,
        runs            INTEGER DEFAULT 0,
        ast             TEXT
      )
    `);

    // Migration for AST
    try {
      this.db.run(`ALTER TABLE workflows ADD COLUMN ast TEXT`);
    } catch {
      // Ignored if column already exists
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS scores (
        id         TEXT PRIMARY KEY,
        run_id     TEXT,
        name       TEXT,
        value      REAL,
        label      TEXT,
        source     TEXT,
        comment    TEXT,
        created_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS wiki_entries (
        id         TEXT PRIMARY KEY,
        title      TEXT,
        content    TEXT,
        tags       TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS provider_outcomes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        provider   TEXT,
        success    INTEGER,
        latency_ms REAL,
        error      TEXT,
        created_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_outcomes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tool       TEXT,
        success    INTEGER,
        run_id     TEXT,
        created_at TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        run_id     TEXT,
        text       TEXT,
        status     TEXT DEFAULT 'open',
        created_at TEXT
      )
    `);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Current time as ISO-8601 UTC string. */
  private now(): string {
    return new Date().toISOString();
  }

  /** Generate a v4 UUID. */
  private uuid(): string {
    return crypto.randomUUID();
  }

  // =====================================================================
  // WIKI
  // =====================================================================

  listWikiEntries(): Array<{ id: string; title: string; content: string; tags: string[]; created_at: string; updated_at: string }> {
    this._stmtListWikiEntries ??= this.db.prepare('SELECT * FROM wiki_entries ORDER BY updated_at DESC');
    const rows = this._stmtListWikiEntries.all() as any[];
    return rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] }));
  }

  addWikiEntry(title: string, content: string, tags: string[] = []): string {
    const id = this.uuid();
    const now = this.now();
    this._stmtInsertWikiEntry ??= this.db.prepare(
      'INSERT INTO wiki_entries (id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this._stmtInsertWikiEntry.run(id, title, content, JSON.stringify(tags), now, now);
    return id;
  }

  updateWikiEntry(id: string, title: string, content: string, tags: string[] = []): boolean {
    this._stmtUpdateWikiEntry ??= this.db.prepare(
      'UPDATE wiki_entries SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?'
    );
    const res = this._stmtUpdateWikiEntry.run(title, content, JSON.stringify(tags), this.now(), id);
    return res.changes > 0;
  }

  deleteWikiEntry(id: string): boolean {
    this._stmtDeleteWikiEntry ??= this.db.prepare('DELETE FROM wiki_entries WHERE id = ?');
    const res = this._stmtDeleteWikiEntry.run(id);
    return res.changes > 0;
  }

  // =====================================================================
  // SESSION MANAGEMENT
  // =====================================================================

  /**
   * Return an existing session id or create a new one.
   *
   * @param sessionId – If non-null and already exists, touch `updated_at`.
   *                     If non-null but missing, create with that id.
   *                     If null, generate a fresh id.
   * @param titleHint – Optional title when creating a new session.
   */
  ensureSession(sessionId: string | null, titleHint?: string): string {
    const ts = this.now();

    if (sessionId) {
      this._stmtGetSession ??= this.db.prepare(
        'SELECT id FROM sessions WHERE id = ?',
      );
      const existing = this._stmtGetSession.get(sessionId) as
        | { id: string }
        | null;

      if (existing) {
        this._stmtUpdateSessionTime ??= this.db.prepare(
          'UPDATE sessions SET updated_at = ? WHERE id = ?',
        );
        this._stmtUpdateSessionTime.run(ts, sessionId);
        return sessionId;
      }
    }

    const id = sessionId ?? this.uuid();
    const title = titleHint ?? `Session ${id.slice(0, 8)}`;

    this._stmtInsertSession ??= this.db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    this._stmtInsertSession.run(id, title, ts, ts);

    // Bootstrap an empty session_state row so later UPSERTs always work.
    this._stmtUpsertState ??= this.db.prepare(`
      INSERT INTO session_state (session_id, synopsis, topic, core_memory)
      VALUES (?, '', '', '')
      ON CONFLICT(session_id) DO NOTHING
    `);
    this._stmtUpsertState.run(id);

    return id;
  }

  /**
   * List all sessions ordered by most-recently updated.
   */
  listSessions(): SessionRow[] {
    this._stmtListSessions ??= this.db.prepare(
      'SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    );
    return this._stmtListSessions.all() as SessionRow[];
  }

  /**
   * Branch a session at a specific run.
   * Clones the session state, all runs up to targetRunId, messages, and notes.
   * Returns the new session ID.
   */
  branchSession(oldSessionId: string, targetRunId: string, eventsDir: string): string {
    const newSessionId = this.uuid();
    const ts = this.now();

    const oldSession = this.db.prepare('SELECT title FROM sessions WHERE id = ?').get(oldSessionId) as any;
    const title = oldSession ? `Fork of ${oldSession.title}` : `Fork ${newSessionId.slice(0, 8)}`;
    this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(newSessionId, title, ts, ts);

    this.db.prepare(`
      INSERT INTO session_state (session_id, synopsis, topic, core_memory)
      SELECT ?, synopsis, topic, core_memory FROM session_state WHERE session_id = ?
    `).run(newSessionId, oldSessionId);

    const targetRun = this.db.prepare('SELECT started_at FROM runs WHERE id = ?').get(targetRunId) as any;
    if (!targetRun) return newSessionId;
    
    const runsToCopy = this.db.prepare('SELECT * FROM runs WHERE session_id = ? AND started_at <= ? ORDER BY started_at ASC').all(oldSessionId, targetRun.started_at) as any[];

    for (const run of runsToCopy) {
      const newRunId = this.uuid();
      
      this.db.prepare(`
        INSERT INTO runs (id, session_id, message, status, final_text, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newRunId, newSessionId, run.message, run.status, run.final_text, run.started_at, run.finished_at);

      this.db.prepare(`
        INSERT INTO messages (session_id, role, content, run_id, created_at)
        SELECT ?, role, content, ?, created_at FROM messages WHERE run_id = ?
      `).run(newSessionId, newRunId, run.id);

      this.db.prepare(`
        INSERT INTO notes (id, session_id, run_id, kind, content, created_at)
        SELECT hex(randomblob(16)), ?, ?, kind, content, created_at FROM notes WHERE run_id = ?
      `).run(newSessionId, newRunId, run.id);
      
      try {
        const fs = require('fs');
        const path = require('path');
        const oldFile = path.join(eventsDir, `${run.id}.jsonl`);
        const newFile = path.join(eventsDir, `${newRunId}.jsonl`);
        if (fs.existsSync(oldFile)) {
           fs.copyFileSync(oldFile, newFile);
        }
      } catch (e) {
        console.error('[SQLite] Failed to copy event file for branch', e);
      }
    }

    return newSessionId;
  }

  // =====================================================================
  // MESSAGE MANAGEMENT
  // =====================================================================

  /**
   * Append a chat message to the history for `sessionId`.
   */
  appendMessage(
    sessionId: string,
    role: string,
    content: string,
    runId?: string,
  ): void {
    this._stmtInsertMessage ??= this.db.prepare(
      'INSERT INTO messages (session_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this._stmtInsertMessage.run(sessionId, role, content, runId ?? null, this.now());
  }

  /**
   * Retrieve the most recent `limit` messages for a session, oldest first.
   *
   * @param limit – Max messages to return (default 50).
   */
  getHistory(sessionId: string, limit = 50): Message[] {
    // We select the newest N then reverse so the caller gets chronological order.
    this._stmtGetHistory ??= this.db.prepare(`
      SELECT * FROM (
        SELECT id, session_id, role, content, run_id, created_at
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) sub ORDER BY id ASC
    `);
    return this._stmtGetHistory.all(sessionId, limit) as Message[];
  }

  // =====================================================================
  // RUN MANAGEMENT
  // =====================================================================

  /**
   * Record the start of a new agent run.
   */
  startRun(runId: string, sessionId: string, message: string): void {
    this._stmtInsertRun ??= this.db.prepare(
      'INSERT INTO runs (id, session_id, message, status, started_at) VALUES (?, ?, ?, ?, ?)',
    );
    this._stmtInsertRun.run(runId, sessionId, message, 'running', this.now());
  }

  /**
   * Mark a run as finished (status = 'done' | 'error' | …).
   */
  finishRun(runId: string, status: string, finalText?: string): void {
    this._stmtFinishRun ??= this.db.prepare(
      'UPDATE runs SET status = ?, final_text = ?, finished_at = ? WHERE id = ?',
    );
    this._stmtFinishRun.run(status, finalText ?? null, this.now(), runId);
  }

  /**
   * List most recent runs across all sessions.
   */
  listRuns(limit = 20): Array<Record<string, unknown>> {
    this._stmtListRuns ??= this.db.prepare(
      'SELECT * FROM runs ORDER BY started_at DESC LIMIT ?',
    );
    return this._stmtListRuns.all(limit) as Array<Record<string, unknown>>;
  }


  private _stmtListSessionRuns?: ReturnType<Database['prepare']>;
  listSessionRuns(sessionId: string, limit = 100): Array<Record<string, unknown>> {
    this._stmtListSessionRuns ??= this.db.prepare(
      'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC LIMIT ?',
    );
    return this._stmtListSessionRuns.all(sessionId, limit) as Array<Record<string, unknown>>;
  }

  // =====================================================================
  // NOTES / MEMORY
  // =====================================================================

  /**
   * Create a new note and return its UUID.
   */
  addNote(
    sessionId: string,
    runId: string,
    kind: string,
    content: string,
  ): string {
    const id = this.uuid();
    this._stmtInsertNote ??= this.db.prepare(
      'INSERT INTO notes (id, session_id, run_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this._stmtInsertNote.run(id, sessionId, runId, kind, content, this.now());
    return id;
  }

  /**
   * Most recent notes for a session, newest first.
   */
  recentNotes(sessionId: string, limit = 10): Array<{ kind: string; content: string; created_at?: string }> {
    this._stmtRecentNotes ??= this.db.prepare(
      'SELECT kind, content, created_at FROM notes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    return this._stmtRecentNotes.all(sessionId, limit) as Array<{ kind: string; content: string; created_at?: string }>;
  }

  /**
   * List notes with optional filtering by session and/or kind.
   */
  listNotes(
    sessionId?: string,
    kind?: string,
    limit = 50,
  ): Array<Record<string, unknown>> {
    // Build query dynamically based on provided filters.
    const clauses: string[] = [];
    const params: any[] = [];

    if (sessionId) {
      clauses.push('session_id = ?');
      params.push(sessionId);
    }
    if (kind) {
      clauses.push('kind = ?');
      params.push(kind);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    // Dynamic queries cannot be cached as easily, but we still prepare them
    // for parameterised safety.
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as Array<Record<string, unknown>>;
  }

  /**
   * Delete a note by id. Returns true if a row was actually deleted.
   */
  deleteNote(noteId: string): boolean {
    this._stmtDeleteNote ??= this.db.prepare(
      'DELETE FROM notes WHERE id = ?',
    );
    const res = this._stmtDeleteNote.run(noteId);
    return res.changes > 0;
  }

  /** Bulk delete notes. */
  bulkDeleteNotes(ids: string[]): { deleted: string[]; missing: string[] } {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      if (this.deleteNote(id)) deleted.push(id);
      else missing.push(id);
    }
    return { deleted, missing };
  }

  /**
   * Check if a note with similar text already exists for this session.
   */
  noteDuplicateExists(sessionId: string, text: string): boolean {
    // Exact match for now (textsim is in knowledge, store handles exact/near via sql if needed, but we'll do exact here as fallback if textsim isn't used)
    const recent = this.recentNotes(sessionId, 50);
    for (const note of recent) {
      if (typeof note.content === 'string' && nearDuplicate(note.content, text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Return a map of `kind → count` for notes in a session (or globally).
   */
  noteKindCounts(sessionId?: string): Record<string, number> {
    const sql = sessionId
      ? 'SELECT kind, COUNT(*) AS cnt FROM notes WHERE session_id = ? GROUP BY kind'
      : 'SELECT kind, COUNT(*) AS cnt FROM notes GROUP BY kind';
    const stmt = this.db.prepare(sql);
    const rows = (
      sessionId ? stmt.all(sessionId) : stmt.all()
    ) as Array<{ kind: string; cnt: number }>;

    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.cnt;
    return out;
  }

  /**
   * Search notes using BM25 relevance scoring.
   */
  searchNotes(
    query: string,
    sessionId?: string,
    limit = 8,
    allowRecencyFallback = false,
  ): Array<Record<string, any>> {
    let rows: Array<Record<string, any>> = [];
    if (sessionId) {
      const stmt = this.db.prepare(
        'SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC LIMIT 400',
      );
      rows = stmt.all(sessionId) as Array<Record<string, any>>;
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM notes ORDER BY created_at DESC LIMIT 400',
      );
      rows = stmt.all() as Array<Record<string, any>>;
    }

    const docs = rows.map((r) => ({ text: String(r.content || ''), payload: r }));
    const ranked = bm25Rank(query, docs);
    if (ranked.length > 0) {
      return ranked.slice(0, limit).map((x) => x[1]);
    }

    return allowRecencyFallback ? rows.slice(0, limit) : [];
  }

  /**
   * Self-editing core memory (add/replace/remove).
   */
  editCoreMemory(
    sessionId: string,
    action: string,
    content: string,
    target = '',
    charLimit = 1600,
  ): { success: boolean; message: string } {
    const current = this.getCoreMemory(sessionId);
    let lines = current.split('\n').map((l) => l.trim()).filter(Boolean);
    const act = (action || '').toLowerCase();

    if (act === 'list') {
      return { success: true, message: lines.length > 0 ? lines.join('\n') : '(empty)' };
    } else if (act === 'clear') {
      lines = [];
    } else if (act === 'add') {
      const item = content.trim().replace(/^-\s*/, '').trim();
      if (!item) return { success: false, message: 'nothing to add' };
      for (const l of lines) {
        const existing = l.replace(/^-\s*/, '').trim();
        if (item.toLowerCase() === existing.toLowerCase()) {
          return { success: true, message: 'already present' };
        }
        if (nearDuplicate(item, existing)) {
          return { success: true, message: `already present (near-duplicate of: ${existing})` };
        }
      }
      lines.push('- ' + item);
    } else if (act === 'replace') {
      if (!target) return { success: false, message: 'replace needs a target substring' };
      const hit = lines.findIndex((l) => l.toLowerCase().includes(target.toLowerCase()));
      if (hit === -1) return { success: false, message: `no memory line matching '${target}'` };
      lines[hit] = '- ' + content.replace(/^-\s*/, '').trim();
    } else if (act === 'remove') {
      const before = lines.length;
      lines = lines.filter((l) => !l.toLowerCase().includes(target.toLowerCase()));
      if (lines.length === before) {
        return { success: false, message: `no memory line matching '${target}'` };
      }
    } else {
      return { success: false, message: `unknown action '${action}' (use add|replace|remove|list|clear)` };
    }

    const newMemory = lines.join('\n');
    if (newMemory.length > charLimit) {
      return {
        success: false,
        message: `core memory would exceed ${charLimit} chars — remove or replace an older line first to make room`,
      };
    }
    this.setCoreMemory(sessionId, newMemory);
    return { success: true, message: `core memory ${action}ed (${newMemory.length}/${charLimit} chars)` };
  }

  /**
   * Recent runs that halted (cancelled/failed) — candidates for continuation.
   */
  openThreads(sessionId: string, excludeRun = '', limit = 4): Array<Record<string, any>> {
    const stmt = this.db.prepare(
      "SELECT id, status, message as user_message, started_at FROM runs " +
      "WHERE session_id = ? AND status IN ('cancelled', 'failed') AND id != ? " +
      "ORDER BY started_at DESC LIMIT ?"
    );
    return stmt.all(sessionId, excludeRun, limit) as Array<Record<string, any>>;
  }

  // =====================================================================
  // SESSION STATE (synopsis, topic, core_memory)
  // =====================================================================

  /**
   * Get the state record for a session. Returns sensible defaults if no
   * row exists yet.
   */
  getSessionState(sessionId: string): SessionState {
    this._stmtGetState ??= this.db.prepare(
      'SELECT synopsis, topic, core_memory FROM session_state WHERE session_id = ?',
    );
    const row = this._stmtGetState.get(sessionId) as SessionState | null;
    return row ?? { synopsis: '', topic: '', core_memory: '' };
  }

  /**
   * Merge partial updates into the session state row (upsert).
   */
  setSessionState(
    sessionId: string,
    updates: Partial<SessionState>,
  ): void {
    const current = this.getSessionState(sessionId);
    const merged = { ...current, ...updates };

    const stmt = this.db.prepare(`
      INSERT INTO session_state (session_id, synopsis, topic, core_memory)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        synopsis    = excluded.synopsis,
        topic       = excluded.topic,
        core_memory = excluded.core_memory
    `);
    stmt.run(sessionId, merged.synopsis, merged.topic, merged.core_memory);
  }

  /** Convenience: read just the core_memory blob. */
  getCoreMemory(sessionId: string): string {
    return this.getSessionState(sessionId).core_memory;
  }

  /** Convenience: overwrite just the core_memory blob. */
  setCoreMemory(sessionId: string, content: string): void {
    this.setSessionState(sessionId, { core_memory: content });
  }

  // =====================================================================
  // SCHEDULES
  // =====================================================================

  /**
   * Register a recurring schedule and return the created row.
   */
  addSchedule(
    message: string,
    everyS: number,
    provider: string,
    sessionId: string,
  ): Record<string, unknown> {
    const id = this.uuid();
    this._stmtInsertSchedule ??= this.db.prepare(
      'INSERT INTO schedules (id, message, every_s, provider, session_id) VALUES (?, ?, ?, ?, ?)',
    );
    this._stmtInsertSchedule.run(id, message, everyS, provider, sessionId);

    return { id, message, every_s: everyS, provider, session_id: sessionId, enabled: 1 };
  }

  /** List all schedules. */
  listSchedules(): Array<Record<string, unknown>> {
    this._stmtListSchedules ??= this.db.prepare('SELECT * FROM schedules');
    return this._stmtListSchedules.all() as Array<Record<string, unknown>>;
  }

  /** Enable or disable a schedule. Returns true if row existed. */
  setScheduleEnabled(id: string, enabled: boolean): boolean {
    this._stmtSetScheduleEnabled ??= this.db.prepare(
      'UPDATE schedules SET enabled = ? WHERE id = ?',
    );
    const res = this._stmtSetScheduleEnabled.run(enabled ? 1 : 0, id);
    return res.changes > 0;
  }

  /** Delete a schedule. Returns true if row existed. */
  deleteSchedule(id: string): boolean {
    this._stmtDeleteSchedule ??= this.db.prepare(
      'DELETE FROM schedules WHERE id = ?',
    );
    const res = this._stmtDeleteSchedule.run(id);
    return res.changes > 0;
  }

  /** Get schedules that are due to run. */
  dueSchedules(now: number): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(`
      SELECT * FROM schedules 
      WHERE enabled = 1 
      AND (last_run IS NULL OR (strftime('%s', 'now') - strftime('%s', last_run)) >= every_s)
    `);
    return stmt.all() as Array<Record<string, unknown>>;
  }

  /** Mark a schedule as fired. */
  markScheduleFired(id: string, nextTs: number, runId: string, status: string): void {
    const stmt = this.db.prepare(
      'UPDATE schedules SET last_run = ?, runs = runs + 1 WHERE id = ?'
    );
    stmt.run(this.now(), id);
  }

  // =====================================================================
  // CUSTOM TOOLS
  // =====================================================================

  /**
   * Insert or update a custom tool spec.
   *
   * `spec` must include at least `name`. Other fields default to empty.
   */
  upsertCustomTool(spec: Record<string, unknown>): void {
    const name = spec.name as string;
    const stmt = this.db.prepare(`
      INSERT INTO custom_tools (name, description, url, method, headers, query, body, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        url         = excluded.url,
        method      = excluded.method,
        headers     = excluded.headers,
        query       = excluded.query,
        body        = excluded.body,
        enabled     = excluded.enabled
    `);
    stmt.run(
      name,
      (spec.description as string) ?? '',
      (spec.url as string) ?? '',
      (spec.method as string) ?? 'GET',
      typeof spec.headers === 'string'
        ? spec.headers
        : JSON.stringify(spec.headers ?? {}),
      typeof spec.query === 'string'
        ? spec.query
        : JSON.stringify(spec.query ?? {}),
      typeof spec.body === 'string'
        ? spec.body
        : JSON.stringify(spec.body ?? {}),
      spec.enabled !== undefined ? (spec.enabled ? 1 : 0) : 1,
    );
  }

  /** List all custom tools. */
  listCustomTools(): Array<Record<string, unknown>> {
    this._stmtListCustomTools ??= this.db.prepare('SELECT * FROM custom_tools');
    return this._stmtListCustomTools.all() as Array<Record<string, unknown>>;
  }

  /** Enable or disable a custom tool. */
  setCustomToolEnabled(name: string, enabled: boolean): boolean {
    this._stmtSetCustomToolEnabled ??= this.db.prepare(
      'UPDATE custom_tools SET enabled = ? WHERE name = ?',
    );
    const res = this._stmtSetCustomToolEnabled.run(enabled ? 1 : 0, name);
    return res.changes > 0;
  }

  /** Delete a custom tool. */
  deleteCustomTool(name: string): boolean {
    this._stmtDeleteCustomTool ??= this.db.prepare(
      'DELETE FROM custom_tools WHERE name = ?',
    );
    const res = this._stmtDeleteCustomTool.run(name);
    return res.changes > 0;
  }

  // =====================================================================
  // WORKFLOWS
  // =====================================================================

  /**
   * Insert or update a workflow definition.
   *
   * `data` must include at least `slug`.
   */
  upsertWorkflow(data: Record<string, unknown>): void {
    const slug = data.slug as string;
    const stmt = this.db.prepare(`
      INSERT INTO workflows (slug, title, description, prompt_template, provider, model, arg_names, enabled, runs, ast)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title           = excluded.title,
        description     = excluded.description,
        prompt_template = excluded.prompt_template,
        provider        = excluded.provider,
        model           = excluded.model,
        arg_names       = excluded.arg_names,
        enabled         = excluded.enabled,
        ast             = excluded.ast
    `);
    stmt.run(
      slug,
      (data.title as string) ?? slug,
      (data.description as string) ?? '',
      (data.prompt_template as string) ?? '',
      (data.provider as string) ?? '',
      (data.model as string) ?? '',
        Array.isArray(data.arg_names)
          ? JSON.stringify(data.arg_names)
          : (data.arg_names as string) ?? '[]',
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
        typeof data.ast === 'object' ? JSON.stringify(data.ast) : (data.ast as string) ?? null,
      );
    }

  /** List all workflows. */
  listWorkflows(): Array<Record<string, unknown>> {
    this._stmtListWorkflows ??= this.db.prepare('SELECT * FROM workflows');
    return this._stmtListWorkflows.all() as Array<Record<string, unknown>>;
  }

  /** Get a single workflow by slug, or null. */
  getWorkflow(slug: string): Record<string, unknown> | null {
    this._stmtGetWorkflow ??= this.db.prepare(
      'SELECT * FROM workflows WHERE slug = ?',
    );
    return (this._stmtGetWorkflow.get(slug) as Record<string, unknown>) ?? null;
  }

  /** Delete a workflow. */
  deleteWorkflow(slug: string): boolean {
    this._stmtDeleteWorkflow ??= this.db.prepare(
      'DELETE FROM workflows WHERE slug = ?',
    );
    const res = this._stmtDeleteWorkflow.run(slug);
    return res.changes > 0;
  }

  /** Increment the run counter for a workflow. */
  bumpWorkflowRuns(slug: string): void {
    this._stmtBumpWorkflowRuns ??= this.db.prepare(
      'UPDATE workflows SET runs = runs + 1 WHERE slug = ?',
    );
    this._stmtBumpWorkflowRuns.run(slug);
  }

  // =====================================================================
  // SCORES
  // =====================================================================

  /**
   * Record an evaluation score for a run. Returns the new score id.
   */
  addScore(
    runId: string,
    name: string,
    value: unknown,
    label: string,
    source: string,
    comment: string,
  ): string {
    const id = this.uuid();
    const numericValue = typeof value === 'number' ? value : Number(value);

    this._stmtInsertScore ??= this.db.prepare(
      'INSERT INTO scores (id, run_id, name, value, label, source, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this._stmtInsertScore.run(
      id,
      runId,
      name,
      numericValue,
      label,
      source,
      comment,
      this.now(),
    );
    return id;
  }

  /** All scores for a given run. */
  runScores(runId: string): Array<Record<string, unknown>> {
    this._stmtRunScores ??= this.db.prepare(
      'SELECT * FROM scores WHERE run_id = ? ORDER BY created_at ASC',
    );
    return this._stmtRunScores.all(runId) as Array<Record<string, unknown>>;
  }

  /**
   * Aggregate score summary across all runs:
   * `{ name → { count, mean, min, max } }`.
   */
  scoreSummary(): Record<string, unknown> {
    const stmt = this.db.prepare(`
      SELECT name,
             COUNT(*)  AS count,
             AVG(value) AS mean,
             MIN(value) AS min,
             MAX(value) AS max
      FROM scores
      GROUP BY name
    `);
    const rows = stmt.all() as Array<{
      name: string;
      count: number;
      mean: number;
      min: number;
      max: number;
    }>;

    const out: Record<string, unknown> = {};
    for (const r of rows) {
      out[r.name] = { count: r.count, mean: r.mean, min: r.min, max: r.max };
    }
    return out;
  }

  // =====================================================================
  // TOOL RELIABILITY
  // =====================================================================

  /** Record whether a tool invocation succeeded or failed. */
  recordToolOutcome(tool: string, success: boolean, runId: string): void {
    this._stmtRecordToolOutcome ??= this.db.prepare(
      'INSERT INTO tool_outcomes (tool, success, run_id, created_at) VALUES (?, ?, ?, ?)',
    );
    this._stmtRecordToolOutcome.run(tool, success ? 1 : 0, runId, this.now());
  }

  /**
   * Per-tool success/failure counts.
   */
  toolReliability(): ToolReliabilityRow[] {
    this._stmtToolReliability ??= this.db.prepare(`
      SELECT tool,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail
      FROM tool_outcomes
      GROUP BY tool
    `);
    return this._stmtToolReliability.all() as ToolReliabilityRow[];
  }

  // =====================================================================
  // PROVIDER OUTCOMES
  // =====================================================================

  /** Log the result of an LLM provider call for latency / error tracking. */
  recordProviderOutcome(
    provider: string,
    success: boolean,
    latencyMs: number,
    error?: string,
  ): void {
    this._stmtRecordProviderOutcome ??= this.db.prepare(
      'INSERT INTO provider_outcomes (provider, success, latency_ms, error, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this._stmtRecordProviderOutcome.run(
      provider,
      success ? 1 : 0,
      latencyMs,
      error ?? null,
      this.now(),
    );
  }

  // =====================================================================
  // TASKS
  // =====================================================================

  /**
   * Return open tasks for a session, optionally filtered to a specific run.
   */
  openTasks(
    sessionId: string,
    runId?: string,
  ): Array<Record<string, unknown>> {
    if (runId) {
      const stmt = this.db.prepare(
        "SELECT * FROM tasks WHERE session_id = ? AND run_id = ? AND status = 'open' ORDER BY created_at ASC",
      );
      return stmt.all(sessionId, runId) as Array<Record<string, unknown>>;
    }

    const stmt = this.db.prepare(
      "SELECT * FROM tasks WHERE session_id = ? AND status = 'open' ORDER BY created_at ASC",
    );
    return stmt.all(sessionId) as Array<Record<string, unknown>>;
  }

  /** Add a new task to a session. */
  addTask(sessionId: string, runId: string | null, text: string): string {
    const id = this.uuid();
    this._stmtInsertTask ??= this.db.prepare(
      'INSERT INTO tasks (id, session_id, run_id, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this._stmtInsertTask.run(id, sessionId, runId, text, 'open', this.now());
    return id;
  }

  /** Complete a task. */
  completeTask(sessionId: string, ident: string): boolean {
    const stmt = this.db.prepare(
      "UPDATE tasks SET status = 'completed' WHERE session_id = ? AND (id = ? OR text LIKE ?)"
    );
    const res = stmt.run(sessionId, ident, `%${ident}%`);
    return res.changes > 0;
  }
}

import React from "react";
import { ArrowLeft, Wrench, Check, X, Loader2, ChevronRight, MessageSquare, Sparkles } from "lucide-react";
import { DataView } from "./DataView.jsx";

/** A single chat bubble. role: 'user' | 'assistant' */
export function MessageBubble({ role, children }) {
  return <div className={"morph-bubble " + role}>{children}</div>;
}

/** Clickable summary of a tool call, sits inline in the message list. */
export function ToolChip({ name, status = "running", onClick }) {
  return (
    <div className="morph-toolchip" onClick={onClick} role="button">
      <span className={"morph-status-dot " + status} />
      <Wrench size={12} />
      <span>{name}</span>
      <ChevronRight size={12} className="morph-chip-arrow" />
    </div>
  );
}

/** Full detail view for one tool call: status banner, query, result / skeleton. */
export function ToolDetailView({ tool, onBack }) {
  if (!tool) return <div className="morph-tool-detail">No tool call selected.</div>;
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";

  return (
    <div className="morph-tool-detail">
      {onBack && (
        <div className="morph-pill-btn" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </div>
      )}
      <div className={"morph-status-banner " + tool.status}>
        {isRunning && <Loader2 size={16} className="morph-spin" />}
        {tool.status === "success" && <Check size={16} />}
        {isError && <X size={16} />}
        <span>{isRunning ? "Running…" : tool.status === "success" ? "Completed successfully" : "Call failed"}</span>
      </div>

      <div>
        <p className="morph-section-label">Query</p>
        <DataView value={tool.query} label="query" />
      </div>

      <div>
        <p className="morph-section-label">Result</p>
        {isRunning ? (
          <div className="morph-skeleton">
            <div className="morph-skel-line" style={{ width: "95%" }} />
            <div className="morph-skel-line" style={{ width: "80%" }} />
            <div className="morph-skel-line" style={{ width: "60%" }} />
          </div>
        ) : (
          <DataView value={tool.result} label="result" />
        )}
      </div>

      <div className="morph-meta-row">
        <span>started {tool.startedAt}</span>
        {tool.duration && <span>duration {tool.duration}</span>}
      </div>
    </div>
  );
}

/** Flat, scrollable timeline of every message + tool call. */
export function HistoryView({ messages, onOpenTool }) {
  return (
    <div className="morph-history">
      {messages.map((m) =>
        m.type === "tool_call" ? (
          <div key={m.id} className="morph-history-row clickable" onClick={() => onOpenTool(m.toolCall.id)}>
            <div className="morph-history-icon">
              <Wrench size={11} />
            </div>
            <div className="morph-history-text">
              <div className="morph-history-role">tool call · {m.toolCall.status}</div>
              {m.toolCall.name}({JSON.stringify(m.toolCall.query)})
            </div>
            <ChevronRight size={13} className="morph-chip-arrow" />
          </div>
        ) : (
          <div key={m.id} className="morph-history-row">
            <div className="morph-history-icon">
              {m.role === "user" ? <Sparkles size={11} /> : <MessageSquare size={11} />}
            </div>
            <div className="morph-history-text">
              <div className="morph-history-role">{m.role}</div>
              {m.content}
            </div>
          </div>
        )
      )}
    </div>
  );
}

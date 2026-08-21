import React from 'react';
import { ArrowLeft, Loader2, Check, X } from 'lucide-react';
import { DataView } from './DataView';

export function ToolDetailPane({ tool, onBack }) {
  if (!tool) return <div className="tool-detail">No tool call selected.</div>;
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";

  return (
    <div className="tool-detail">
      {onBack && (
        <button className="back-btn" onClick={onBack}>
          <ArrowLeft size={13} /> Back to view
        </button>
      )}

      <div className={`status-banner ${tool.status || 'running'}`}>
        {isRunning && <Loader2 size={16} className="spin" />}
        {tool.status === "success" && <Check size={16} />}
        {isError && <X size={16} />}
        <span>{isRunning ? "Tool call in progress..." : tool.status === "success" ? "Call executed successfully" : "Execution failed"}</span>
      </div>

      <div>
        <p className="section-label">Query Arguments</p>
        <DataView value={tool.query} label="query" />
      </div>

      <div>
        <p className="section-label">Output Result</p>
        {isRunning ? (
          <div className="data-view skeleton">
            <div className="skel-line" style={{ width: "92%" }} />
            <div className="skel-line" style={{ width: "75%" }} />
            <div className="skel-line" style={{ width: "55%" }} />
          </div>
        ) : (
          <DataView value={tool.result || tool.content || tool.error} label="result" />
        )}
      </div>

      <div className="meta-row">
        <span>started: {tool.startedAt || 'just now'}</span>
        {tool.duration && <span>duration: {tool.duration}</span>}
      </div>
    </div>
  );
}

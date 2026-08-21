import React from "react";
import { Wrench, ChevronRight, Loader2, Check, X } from "lucide-react";
import { registerNodeKind } from "./MorphNode.jsx";
import { DataView } from "./DataView.jsx";

function ToolNodeSummary({ node, canExpand, onClick }) {
  const status = node.tool.status;
  return (
    <div className="morph-toolchip" onClick={onClick} role={canExpand ? "button" : undefined}>
      <span className={"morph-status-dot " + status} />
      <Wrench size={12} />
      <span>{node.tool.name}</span>
      {canExpand && <ChevronRight size={12} className="morph-chip-arrow" />}
    </div>
  );
}

/**
 * Build a tool-call leaf for the MorphNode tree. Its collapsed form is the
 * familiar chip; its expanded form uses DataView so the query/result render
 * through the same adapter system as everywhere else — tables, stat grids,
 * etc, not raw JSON.
 */
export function toolNode(tool) {
  return {
    id: tool.id,
    kind: "tool",
    label: tool.name,
    tool,
    renderExpanded: () => {
      const isRunning = tool.status === "running";
      const isError = tool.status === "error";
      return (
        <div className="morph-tool-detail" style={{ padding: 0 }}>
          <div className={"morph-status-banner " + tool.status}>
            {isRunning && <Loader2 size={16} className="morph-spin" />}
            {tool.status === "success" && <Check size={16} />}
            {isError && <X size={16} />}
            <span>{isRunning ? "Running…" : isError ? "Call failed" : "Completed successfully"}</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <p className="morph-section-label">Query</p>
            <DataView value={tool.query} />
          </div>
          <div style={{ marginTop: 12 }}>
            <p className="morph-section-label">Result</p>
            {isRunning ? (
              <div className="morph-skeleton">
                <div className="morph-skel-line" style={{ width: "95%" }} />
                <div className="morph-skel-line" style={{ width: "80%" }} />
              </div>
            ) : (
              <DataView value={tool.result} />
            )}
          </div>
        </div>
      );
    },
  };
}

registerNodeKind("tool", ToolNodeSummary);

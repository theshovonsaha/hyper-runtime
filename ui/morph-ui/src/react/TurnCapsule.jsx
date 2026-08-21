import React, { useEffect, useState } from "react";
import { ChevronRight, Wrench, Sparkles, Check } from "lucide-react";
import { MorphShape } from "./MorphShape.jsx";
import { ToolChip } from "./chatkit.jsx";

/** Pull a short, honest ticker string out of whatever step is currently active. */
function tickerFor(turn) {
  const running = turn.steps.find((s) => s.type === "tool_call" && s.tool.status === "running");
  if (running) {
    const q = JSON.stringify(running.tool.query || {});
    return `${running.tool.name}(${q.length > 34 ? q.slice(0, 34) + "…" : q})`;
  }
  const lastReasoning = [...turn.steps].reverse().find((s) => s.type === "reasoning");
  if (lastReasoning) return lastReasoning.text;
  return "thinking…";
}

/**
 * <TurnCapsule turn={turn} onOpen={() => push({type:'turn', turnId: turn.id})} />
 *
 * While `turn.status === 'running'` this shows a scanning glass pill with a
 * live one-line ticker of real (truncated) step detail. Once done it settles
 * into a compact summary chip — same element, different phase.
 */
export function TurnCapsule({ turn, onOpen }) {
  const [tick, setTick] = useState(() => tickerFor(turn));

  useEffect(() => {
    if (turn.status !== "running") return;
    const id = setInterval(() => setTick(tickerFor(turn)), 850);
    return () => clearInterval(id);
  }, [turn]);

  const toolCount = turn.steps.filter((s) => s.type === "tool_call").length;

  return (
    <div className={"morph-turn-capsule " + turn.status} onClick={onOpen} role="button">
      <div className="morph-turn-avatar">
        <MorphShape
          type={turn.status === "running" ? "blob" : turn.status === "error" ? "star" : "hexagon"}
          color={turn.status === "running" ? "#22D3EE" : turn.status === "error" ? "#FB7185" : "#A3E635"}
          size={20}
          animate={turn.status === "running"}
          speed={0.9}
        />
      </div>
      <div className="morph-turn-body">
        {turn.status === "running" ? (
          <>
            <div className="morph-turn-scan" />
            <span className="morph-turn-ticker">{tick}</span>
          </>
        ) : (
          <span className="morph-turn-summary">
            {toolCount > 0 ? `used ${toolCount} tool${toolCount > 1 ? "s" : ""}` : "reasoned"} · tap to view
          </span>
        )}
      </div>
      <ChevronRight size={13} className="morph-chip-arrow" />
    </div>
  );
}

/**
 * <TurnDetailView turn={turn} onOpenTool={(toolId) => push({type:'tool', toolId})} />
 * Full breakdown of one turn: reasoning notes interleaved with tool calls,
 * in the order they actually happened. Each tool call is itself the same
 * clickable ToolChip used in the plain chat list, so it opens the same
 * ToolDetailView one level deeper on the stack.
 */
export function TurnDetailView({ turn, onOpenTool }) {
  return (
    <div className="morph-turn-detail">
      <div className={"morph-status-banner " + (turn.status === "running" ? "running" : turn.status === "error" ? "error" : "success")}>
        {turn.status === "running" ? <Sparkles size={16} /> : <Check size={16} />}
        <span>{turn.status === "running" ? "Still processing this turn…" : "Turn complete"}</span>
      </div>

      <div className="morph-turn-timeline">
        {turn.steps.map((step, i) => (
          <div className="morph-turn-step" key={step.id}>
            <div className="morph-turn-step-rail">
              <div className={"morph-turn-step-dot " + (step.type === "tool_call" ? step.tool.status : "done")} />
              {i < turn.steps.length - 1 && <div className="morph-turn-step-line" />}
            </div>
            <div className="morph-turn-step-content">
              {step.type === "reasoning" ? (
                <p className="morph-turn-reasoning">{step.text}</p>
              ) : (
                <ToolChip name={step.tool.name} status={step.tool.status} onClick={() => onOpenTool(step.tool.id)} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

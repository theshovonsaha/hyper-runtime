import React from 'react';
import { ArrowLeft, Sparkles, Check } from 'lucide-react';

export function TurnDetailPane({ turn, onOpenTool, onBack }) {
  if (!turn) return <div className="turn-detail">No turn selected.</div>;
  const isRunning = turn.status === "running";

  return (
    <div className="turn-detail">
      {onBack && (
        <button className="back-btn" onClick={onBack}>
          <ArrowLeft size={13} /> Back to chat
        </button>
      )}

      <div className={`status-banner ${isRunning ? 'running' : turn.status === 'error' ? 'error' : 'success'}`}>
        {isRunning ? <Sparkles size={16} /> : <Check size={16} />}
        <span>{isRunning ? "Autonomous turn executing..." : "Turn complete"}</span>
      </div>

      <div className="turn-timeline">
        {(turn.steps || []).map((step, i) => (
          <div className="turn-step" key={step.id || i}>
            <div className="step-rail">
              <div className={`step-dot ${step.type === 'tool_call' ? (step.tool?.status || 'done') : 'done'}`} />
              {i < (turn.steps.length - 1) && <div className="step-line" />}
            </div>
            <div className="step-content">
              {step.type === "reasoning" ? (
                <p className="step-reasoning">{step.text}</p>
              ) : (
                <button className="tool-chip" onClick={() => onOpenTool && onOpenTool(step.tool?.id)}>
                  <span className="chip-dot" />
                  <span>{step.tool?.name || 'tool_call'}</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

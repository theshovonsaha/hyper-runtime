import React from 'react';
import { useShovs } from '../store/ShovsContext';

// Helper mapping equivalent to KIND_COLOR in original HTML
const KIND_COLOR = {
  input: "var(--baseline)", context_item: "var(--c-context)", packet: "var(--c-packet)",
  gate: "var(--c-gate)", plan: "var(--c-packet)", model: "var(--c-model)",
  tool: "var(--c-tool)", verify: "var(--c-gate)",
  output: "var(--c-output)", memory: "var(--c-memory)", error: "var(--s-critical)",
};
const PHASE_COLOR = {
  intake: "var(--baseline)", context: "var(--c-context)", gate: "var(--c-gate)",
  plan: "var(--c-packet)", model: "var(--c-model)", tool: "var(--c-tool)",
  verify: "var(--c-gate)", respond: "var(--c-output)",
  commit: "var(--c-memory)", done: "var(--baseline)",
};
const PHASES = ["intake","context","gate","plan","model","tool","verify","respond","commit","done"];

export function TimelinePane() {
  const { events } = useShovs();

  return (
    <div className="pane active" id="pane-timeline">
      <div className="hint" style={{ marginBottom: 6 }}>
        Live, typed events for the current run. Click any row for its payload.
      </div>
      
      <div className="legend" id="phaseFilter" style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {PHASES.map(p => (
          <span key={p} className="toggle on" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
             <i style={{ width: 8, height: 8, borderRadius: 2, display: 'inline-block', background: PHASE_COLOR[p] }}></i>
             {p}
          </span>
        ))}
      </div>
      
      <div id="timeline" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {events.length === 0 && <div className="hint">No events for current run yet.</div>}
        {events.map((ev, i) => (
          <div key={i} className={`ev ${ev.parent_id ? 'sub' : ''}`} style={{
            display: 'flex', gap: 8, padding: '5px 8px', borderRadius: 8, alignItems: 'baseline', cursor: 'pointer',
            background: 'var(--morph-panel-bg)'
          }}>
            <span className="t" style={{ color: 'var(--muted)', fontSize: 11, width: 52, flex: 'none', textAlign: 'right' }}>
              {(ev.ts || 0).toFixed(2)}s
            </span>
            <span className="chip" style={{
              flex: 'none', fontSize: 10.5, padding: '1px 8px', borderRadius: 999, color: '#fff', minWidth: 58, textAlign: 'center',
              background: PHASE_COLOR[ev.phase] || 'var(--baseline)'
            }}>
              {ev.phase}
            </span>
            <span className="sum" style={{ fontSize: 12.5, color: 'var(--ink-2)', wordBreak: 'break-word' }}>
              {ev.type} — {ev.summary || ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

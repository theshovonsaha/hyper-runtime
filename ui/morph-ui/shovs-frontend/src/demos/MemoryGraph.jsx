import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  Focus,
  Minus,
  Plus,
  RotateCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useShovs } from '../store/ShovsContext';

const colors = {
  session: '#a78bfa',
  run: '#22d3ee',
  message: '#64748b',
  memory: '#fb7185',
  context: '#818cf8',
  source: '#94a3b8',
  proposal: '#f97316',
  capability: '#2dd4bf',
  verification: '#4ade80',
  evidence: '#fbbf24',
};
const typeOrder = Object.keys(colors);
const countKey = { run: 'runs', message: 'messages', memory: 'memories', context: 'contexts', source: 'sources', proposal: 'proposals', capability: 'capabilities', verification: 'verifications', evidence: 'evidence' };
const short = (value = '', size = 34) => value.length > size ? `${value.slice(0, size - 1)}…` : value;

function constellation(nodes, edges) {
  const width = 1200;
  const height = 760;
  const center = { x: width / 2, y: height / 2 };
  const result = new Map();
  const session = nodes.find(node => node.type === 'session');
  if (session) result.set(session.id, { ...session, ...center });

  const runs = nodes.filter(node => node.type === 'run');
  const runRadius = runs.length <= 1 ? 190 : Math.min(285, 205 + runs.length * 18);
  runs.forEach((node, index) => {
    const angle = runs.length === 1 ? 0 : -Math.PI / 2 + index * Math.PI * 2 / runs.length;
    result.set(node.id, {
      ...node,
      x: center.x + Math.cos(angle) * runRadius,
      y: center.y + Math.sin(angle) * runRadius,
      clusterAngle: angle,
    });
  });

  const owner = new Map();
  nodes.forEach(node => {
    if (node.runId) owner.set(node.id, `run:${node.runId}`);
    else if (node.sourceRunId) owner.set(node.id, `run:${node.sourceRunId}`);
  });
  for (let pass = 0; pass < 4; pass += 1) {
    for (const edge of edges) {
      const fromOwner = owner.get(edge.from) || (edge.from.startsWith('run:') ? edge.from : undefined);
      const toOwner = owner.get(edge.to) || (edge.to.startsWith('run:') ? edge.to : undefined);
      if (fromOwner && !toOwner) owner.set(edge.to, fromOwner);
      if (toOwner && !fromOwner) owner.set(edge.from, toOwner);
    }
  }

  const unplaced = nodes.filter(node => !result.has(node.id));
  for (const run of runs) {
    const anchor = result.get(run.id);
    const cluster = unplaced.filter(node => owner.get(node.id) === run.id)
      .sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.id.localeCompare(b.id));
    cluster.forEach((node, index) => {
      const angle = (anchor.clusterAngle || 0) + 0.85 + index * 2.399963;
      const radius = 54 + Math.sqrt(index + 1) * 22;
      result.set(node.id, {
        ...node,
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
      });
    });
  }

  const outside = unplaced.filter(node => !result.has(node.id));
  outside.forEach((node, index) => {
    const angle = -Math.PI / 2 + index * 2.399963;
    const radius = 330 + (index % 3) * 34;
    result.set(node.id, {
      ...node,
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius * 0.78,
    });
  });
  return { nodes: [...result.values()], width, height, center };
}

function radius(node) {
  if (node.type === 'session') return 31;
  if (node.type === 'run') return 25;
  if (node.type === 'memory') return 20;
  if (node.type === 'verification') return 18;
  return 13 + Math.min(5, Math.sqrt(node.degree || 0));
}

export function MemoryGraph() {
  const { sessionId } = useShovs();
  const [graph, setGraph] = useState({ nodes: [], edges: [], counts: {}, integrity: {} });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [edit, setEdit] = useState('');
  const [hiddenTypes, setHiddenTypes] = useState(new Set());
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!sessionId) return setGraph({ nodes: [], edges: [], counts: {}, integrity: {} });
    const result = await api.get('/api/memory/graph', { session_id: sessionId, q: query });
    if (result.error) setError(result.error);
    else {
      setError('');
      setGraph(result);
      setSelected(current => current ? result.nodes.find(node => node.id === current.id) || null : null);
    }
  }, [sessionId, query]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const nodes = (graph.nodes || []).filter(node => !hiddenTypes.has(node.type));
    const ids = new Set(nodes.map(node => node.id));
    const edges = (graph.edges || []).filter(edge => ids.has(edge.from) && ids.has(edge.to));
    const laidOut = constellation(nodes, edges);
    return { ...laidOut, edges };
  }, [graph.nodes, graph.edges, hiddenTypes]);
  const byId = useMemo(() => new Map(visible.nodes.map(node => [node.id, node])), [visible.nodes]);
  const focusIds = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected.id]);
    visible.edges.forEach(edge => {
      if (edge.from === selected.id) ids.add(edge.to);
      if (edge.to === selected.id) ids.add(edge.from);
    });
    return ids;
  }, [selected, visible.edges]);
  const selectedEdges = useMemo(() => selected ? visible.edges.filter(edge => edge.from === selected.id || edge.to === selected.id) : [], [selected, visible.edges]);
  const choose = node => { setSelected(node); setEdit(node.content || ''); };
  const toggleType = type => setHiddenTypes(current => {
    const next = new Set(current);
    if (next.has(type)) next.delete(type); else next.add(type);
    return next;
  });
  const save = async () => {
    if (!selected || selected.type !== 'memory' || !edit.trim()) return;
    const result = await api.patch(`/api/memory/${encodeURIComponent(selected.entityId)}`, { content: edit });
    if (result.error) return setError(result.error);
    setSelected(null);
    await load();
  };
  const remove = async () => {
    if (!selected || selected.type !== 'memory') return;
    if (await api.delete(`/api/memory/${encodeURIComponent(selected.entityId)}`)) {
      setSelected(null);
      await load();
    }
  };
  const integrity = graph.integrity || {};
  const healthy = integrity.orphan_edges === 0 && integrity.failed_verifications === 0 && integrity.canonical_runs === (graph.counts?.runs || 0);

  return <section className="kg-shell">
    <header className="kg-head">
      <div><small>Canonical runtime projection</small><h1><BrainCircuit size={19}/>Runtime Graph</h1></div>
      {sessionId && <span className={`kg-health ${healthy ? 'ok' : 'warn'}`}><ShieldCheck size={13}/>{healthy ? 'linked & verified' : 'inspect integrity'}</span>}
      <label><Search size={14}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find memory, context, tools…"/></label>
      <button onClick={load}><RotateCw size={14}/>Refresh</button>
    </header>
    {!sessionId ? <div className="kg-empty"><BrainCircuit/><strong>No session yet</strong><span>Start a chat first.</span></div> : <div className="kg-workspace">
      <main className="kg-canvas">
        <div className="kg-legend">{typeOrder.filter(type => type === 'session' || graph.counts?.[countKey[type]]).map(type => <button className={hiddenTypes.has(type) ? 'off' : ''} key={type} onClick={() => toggleType(type)}><i style={{ background: colors[type] }}/>{type}</button>)}</div>
        <div className="kg-zoom"><button onClick={() => setZoom(value => Math.max(.65, value - .15))} aria-label="Zoom out"><Minus size={13}/></button><button onClick={() => setZoom(1)} aria-label="Reset zoom"><Focus size={13}/></button><button onClick={() => setZoom(value => Math.min(1.8, value + .15))} aria-label="Zoom in"><Plus size={13}/></button></div>
        <svg viewBox={`0 0 ${visible.width} ${visible.height}`} role="img" aria-label="Runtime memory, context, capability, and verification relationship graph">
          <defs>
            <filter id="kg-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          </defs>
          <g transform={`translate(${visible.center.x} ${visible.center.y}) scale(${zoom}) translate(${-visible.center.x} ${-visible.center.y})`}>
            <g className="kg-links">{visible.edges.map(edge => {
              const from = byId.get(edge.from), to = byId.get(edge.to);
              if (!from || !to) return null;
              const active = selected && (edge.from === selected.id || edge.to === selected.id);
              const dim = focusIds && !active;
              return <g key={edge.id} className={`${active ? 'active' : ''} ${dim ? 'dim' : ''}`}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y}/>{(active || visible.nodes.length < 28) && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 5}>{edge.label}</text>}</g>;
            })}</g>
            <g>{visible.nodes.map(node => {
              const dim = (focusIds && !focusIds.has(node.id)) || (query && !node.matched);
              return <g key={node.id} className={`kg-node ${node.matched ? 'match' : ''} ${node.active === false ? 'muted' : ''} ${selected?.id === node.id ? 'selected' : ''} ${dim ? 'dim' : ''}`} transform={`translate(${node.x} ${node.y})`} onClick={() => choose(node)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') choose(node); }} role="button" tabIndex="0">
                <circle className="halo" r={radius(node) + 7}/><circle r={radius(node)} style={{ fill: colors[node.type] || '#64748b' }}/>
                {node.type === 'verification' && node.active && <CheckCircle2 className="kg-check" x={-7} y={-7} size={14}/>}<text className={['message', 'source', 'capability', 'evidence'].includes(node.type) ? 'secondary' : ''} y={radius(node) + 17}>{short(node.label, 28)}</text><text className={`sub ${['message', 'source', 'capability', 'evidence'].includes(node.type) ? 'secondary' : ''}`} y={radius(node) + 30}>{short(node.detail, 34)}</text>
              </g>;
            })}</g>
          </g>
        </svg>
        <footer>
          <span><b>{integrity.canonical_events || 0}</b>canonical events</span>
          <span><b>{integrity.verified_paths || 0}</b>verified paths</span>
          <span><b>{Math.round((integrity.provenance_coverage || 0) * 100)}%</b>provenance linked</span>
          <span className={integrity.orphan_edges ? 'bad' : ''}><b>{integrity.orphan_edges || 0}</b>orphan links</span>
          <span><b>{integrity.visible_nodes || 0}</b>visible nodes</span>
        </footer>
      </main>
      <aside className="kg-inspect">{selected ? <>
        <header><span style={{ background: colors[selected.type] }}/><div><small>{selected.type} · {selected.canonical ? 'canonical' : 'operator projection'}</small><strong>{short(selected.label, 60)}</strong></div><button onClick={() => setSelected(null)}><X size={14}/></button></header>
        {selected.type === 'memory' ? <><label>Memory<textarea rows="8" value={edit} onChange={event => setEdit(event.target.value)} disabled={!selected.active}/></label><dl><dt>State</dt><dd>{selected.detail}</dd><dt>From</dt><dd>{short(selected.sourceRunId || '—', 28)}</dd><dt>Evidence</dt><dd>{selected.evidenceRefs?.length || 0}</dd><dt>Links</dt><dd>{selected.degree || 0}</dd></dl>{selected.active && <div className="kg-actions"><button onClick={remove}><Trash2 size={13}/>Delete</button><button className="primary" onClick={save}><Save size={13}/>Save copy</button></div>}</> : <><p className="kg-content">{selected.content || selected.detail}</p><dl><dt>Type</dt><dd>{selected.type}</dd><dt>State</dt><dd>{selected.status || (selected.active ? 'active' : 'inactive')}</dd><dt>Links</dt><dd>{selected.degree || 0}</dd><dt>ID</dt><dd>{short(selected.entityId, 34)}</dd>{selected.runId && <><dt>Run</dt><dd>{short(selected.runId, 34)}</dd></>}</dl></>}
        {selectedEdges.length > 0 && <section className="kg-relations"><small>Direct connections</small>{selectedEdges.slice(0, 14).map(edge => { const other = byId.get(edge.from === selected.id ? edge.to : edge.from); return <button key={edge.id} onClick={() => other && choose(other)}><i style={{ background: colors[other?.type] }}/><span><b>{edge.label}</b>{short(other?.label || 'Unknown node', 34)}</span></button>; })}</section>}
      </> : <div className="kg-empty small"><BrainCircuit size={24}/><strong>Pick a node</strong><span>Focus its verified neighborhood.</span></div>}</aside>
    </div>}
    {error && <div className="kg-error">{error}</div>}
  </section>;
}

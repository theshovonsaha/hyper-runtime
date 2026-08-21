import React, { useEffect, useMemo, useState } from 'react';
import { Braces, Search, Wrench, AlertTriangle, Eye, Code2 } from 'lucide-react';
import { api } from '../api';
import { useShovs } from '../store/ShovsContext';

const short=(v='',n=80)=>v.length>n?`${v.slice(0,n-1)}…`:v;

export function ContextInspector(){
  const {sessionId,runId}=useShovs();
  const [runs,setRuns]=useState([]),[selectedRun,setSelectedRun]=useState(runId||''),[data,setData]=useState({packets:[]});
  const [packetIndex,setPacketIndex]=useState(0),[query,setQuery]=useState(''),[raw,setRaw]=useState(false),[error,setError]=useState('');
  useEffect(()=>{api.get('/api/runs',sessionId?{session_id:sessionId}:{}).then(result=>{const list=result.runs||[];setRuns(list);setSelectedRun(current=>current||runId||list[0]?.id||'');});},[sessionId,runId]);
  useEffect(()=>{if(!selectedRun)return;api.get(`/api/runs/${encodeURIComponent(selectedRun)}/context`).then(result=>{if(result.error)setError(result.error);else{setError('');setData(result);setPacketIndex(0);}});},[selectedRun]);
  const packet=data.packets?.[packetIndex];
  const items=useMemo(()=>{const list=packet?.items||[];if(!query)return list;const q=query.toLowerCase();return list.filter(item=>`${item.title} ${item.content} ${item.sourceId}`.toLowerCase().includes(q));},[packet,query]);
  return <section className="ctx-shell">
    <header className="ctx-head"><div><small>Model input</small><h1><Braces size={19}/>Context</h1></div><select value={selectedRun} onChange={e=>setSelectedRun(e.target.value)}>{runs.map(run=><option key={run.id} value={run.id}>{short(run.objective,55)} · {run.status}</option>)}</select><label><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find context"/></label><button className={raw?'on':''} onClick={()=>setRaw(!raw)}><Code2 size={13}/>Raw</button></header>
    {!selectedRun?<div className="ctx-empty"><strong>No run yet</strong><span>Run an agent first.</span></div>:<div className="ctx-grid">
      <nav className="ctx-passes"><small>Passes</small>{(data.packets||[]).map((item,index)=><button key={item.event_id} className={index===packetIndex?'active':''} onClick={()=>setPacketIndex(index)}><b>{String(index+1).padStart(2,'0')}</b><span><strong>{item.phase||'pass'}</strong><small>{item.items?.length||0} in · {item.excluded_source_ids?.length||0} out</small></span></button>)}</nav>
      <main className="ctx-main">{packet&&<>{raw?<pre>{JSON.stringify(packet,null,2)}</pre>:<><header><div><small>Pass {packetIndex+1} · {packet.phase}</small><h2>{short(packet.objective||'Context packet',100)}</h2></div><span>{packet.items?.length||0} items</span></header><div className="ctx-items">{items.map(item=><article key={item.sourceId} className={`${item.instructionEligible?'rule':'data'}`}><header><span>{item.instructionEligible?'rule':'data'}</span><strong>{item.title}</strong><small>{item.estimatedTokens}t</small></header><p>{item.content}</p><footer>{item.authority}<i/> {short(item.sourceId,46)}</footer></article>)}</div></>}</>}</main>
      <aside className="ctx-signals"><section><small>Detected</small>{packet?.signals?.length?packet.signals.map(signal=><article key={signal.id} className={signal.severity}><AlertTriangle size={14}/><div><strong>{signal.kind.replaceAll('_',' ')}</strong><p>{signal.summary}</p></div></article>):<p className="quiet"><Eye size={13}/>No drift found.</p>}</section><section><small>Tool link</small>{packet?.tool_call?<article className="tool"><Wrench size={14}/><div><strong>{packet.tool_call.capability_id}</strong><p>{short(packet.tool_call.target,50)}</p></div></article>:<p className="quiet">No tool on this pass.</p>}</section><section><small>Selection</small><dl><dt>Included</dt><dd>{packet?.included_source_ids?.length||0}</dd><dt>Excluded</dt><dd>{packet?.excluded_source_ids?.length||0}</dd><dt>Conflicts</dt><dd>{packet?.audit?.contradictionCount||0}</dd><dt>History share</dt><dd>{Math.round(((packet?.audit?.tokensBySemanticTag?.conversation||0)/(packet?.audit?.dynamicTokens||1))*100)}%</dd></dl></section><section><small>Left out</small><div className="ctx-excluded">{packet?.exclusions?.slice(0,30).map(item=><span key={item.sourceId}>{short(item.sourceId,28)} <b>{item.reason}</b></span>)||null}</div></section></aside>
    </div>}{error&&<div className="ctx-error">{error}</div>}
  </section>;
}

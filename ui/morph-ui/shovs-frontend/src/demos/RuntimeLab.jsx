import React, { useEffect, useState } from "react";
import {
  Activity, AlertTriangle, Beaker, BrainCircuit, Check, ChevronDown, ChevronRight,
  CircleGauge, Clock3, Database, FlaskConical, GitCompareArrows, History, Layers3,
  Loader2, Play, RefreshCw, Route, Search, ShieldCheck, Sparkles, Target, X,
} from "lucide-react";

const ACCENT={cyan:"#22d3ee",violet:"#8b5cf6",lime:"#a3e635"};
const SCORE_LABEL={outcome:"Outcome",safety:"Safety",evidence:"Evidence",resilience:"Recovery",efficiency:"Efficiency",composite:"Composite"};
const MODULE_ICON={context_compilation:Layers3,authority_policy:ShieldCheck,observed_state:Search,semantic_verification:Target,causal_recovery:Route,effect_reconciliation:RefreshCw,model_fallback:GitCompareArrows,round_robin_routing:Activity,specialized_capabilities:BrainCircuit};

export function RuntimeLab(){
  const [catalog,setCatalog]=useState(null);
  const [runs,setRuns]=useState([]);
  const [scenarioId,setScenarioId]=useState("inspect-proof");
  const [objective,setObjective]=useState("");
  const [selectedAgents,setSelectedAgents]=useState(["verified-minimal","resilient-operator","research-specialist"]);
  const [selectedRuns,setSelectedRuns]=useState([]);
  const [result,setResult]=useState(null);
  const [selectedAnalysis,setSelectedAnalysis]=useState(null);
  const [trace,setTrace]=useState([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [archiveOpen,setArchiveOpen]=useState(false);

  async function bootstrap(){
    setError("");
    try{
      const [catalogResponse,runsResponse]=await Promise.all([fetch("/api/lab/catalog"),fetch("/api/runs")]);
      if(!catalogResponse.ok||!runsResponse.ok) throw new Error("Runtime Lab API is unavailable");
      const nextCatalog=await catalogResponse.json();
      const nextRuns=(await runsResponse.json()).runs||[];
      setCatalog(nextCatalog);setRuns(nextRuns);
      setObjective(current=>current||nextCatalog.scenarios?.[0]?.objective||"");
    }catch(reason){setError(reason.message||"Could not connect to the evaluated runtime");}
  }

  useEffect(()=>{void bootstrap();},[]);
  const scenario=catalog?.scenarios?.find(item=>item.id===scenarioId);
  const agents=catalog?.agents||[];
  const analyses=result?.analyses||[];
  const comparison=result?.comparison;

  function chooseScenario(id){
    const next=catalog?.scenarios?.find(item=>item.id===id);setScenarioId(id);
    if(next)setObjective(next.objective);
  }
  function toggleAgent(id){setSelectedAgents(values=>values.includes(id)?values.filter(value=>value!==id):values.length<3?[...values,id]:values);}
  function toggleRun(id){setSelectedRuns(values=>values.includes(id)?values.filter(value=>value!==id):values.length<4?[...values,id]:values);}

  async function launch(){
    if(selectedAgents.length<2||!objective.trim())return;
    setBusy(true);setError("");setResult(null);setSelectedAnalysis(null);setTrace([]);
    try{
      const response=await fetch("/api/lab/experiments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({objective:objective.trim(),agent_ids:selectedAgents})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||data.outcomes?.map(item=>`${item.agent?.name}: ${item.error||item.status}`).join(" · ")||"Experiment did not produce two analyzable runs");
      setResult(data);if(data.analyses?.[0])await inspect(data.analyses[0]);
      await bootstrap();
    }catch(reason){setError(reason.message||"Experiment failed");}finally{setBusy(false);}
  }

  async function compareArchive(){
    if(selectedRuns.length<2)return;
    setBusy(true);setError("");setSelectedAnalysis(null);setTrace([]);
    try{
      const response=await fetch("/api/lab/compare",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({run_ids:selectedRuns})});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Comparison failed");
      setResult(data);if(data.analyses?.[0])await inspect(data.analyses[0]);setArchiveOpen(false);
    }catch(reason){setError(reason.message||"Comparison failed");}finally{setBusy(false);}
  }

  async function inspect(analysis){
    setSelectedAnalysis(analysis);setTrace([]);
    try{const response=await fetch(`/api/runs/${encodeURIComponent(analysis.run.id)}/events`);if(response.ok)setTrace((await response.json()).events||[]);}catch{/* The scored projection remains available. */}
  }

  return <div className="lab-stage">
    <section className="lab-shell">
      <header className="lab-topbar">
        <div className="lab-title"><span><FlaskConical size={18}/></span><div><small>Hyper research instrument</small><h1>Runtime Lab</h1></div></div>
        <div className="lab-proof"><i/><span><strong>Evidence mode</strong><small>canonical runs + labelled fixtures</small></span></div>
        <button className="lab-archive-button" onClick={()=>setArchiveOpen(value=>!value)}><History size={14}/>Compare past runs<b>{selectedRuns.length||""}</b></button>
      </header>

      <div className="lab-content">
        <aside className="lab-setup">
          <section className="lab-section">
            <div className="lab-section-title"><span>01</span><div><strong>Challenge</strong><small>Same objective, bounded variants</small></div></div>
            <div className="lab-scenario-tabs">{(catalog?.scenarios||[]).map(item=><button key={item.id} className={scenarioId===item.id?"active":""} onClick={()=>chooseScenario(item.id)}>{item.name}</button>)}</div>
            <textarea aria-label="Lab objective" value={objective} onChange={event=>setObjective(event.target.value)} rows={5}/>
            {scenario&&<p className="lab-expected"><Sparkles size={12}/>{scenario.expectedSignal}</p>}
          </section>
          <section className="lab-section agents">
            <div className="lab-section-title"><span>02</span><div><strong>Agent variants</strong><small>Choose two or three</small></div></div>
            <div className="lab-agent-picker">{agents.map(agent=><AgentToggle key={agent.id} agent={agent} selected={selectedAgents.includes(agent.id)} onToggle={()=>toggleAgent(agent.id)}/>)}</div>
          </section>
          <button className="lab-launch" disabled={busy||selectedAgents.length<2||!objective.trim()} onClick={launch}>{busy?<><Loader2 className="spin" size={16}/>Running real agents…</>:<><Play size={15}/>Launch comparison<span>{selectedAgents.length} agents</span></>}</button>
          <p className="lab-safety-note"><ShieldCheck size={12}/>Core policy and verification cannot be disabled on live runs. Unsafe ablations are fixture-only.</p>
        </aside>

        <main className="lab-results">
          {error&&<div className="lab-error"><AlertTriangle size={15}/><span>{error}</span><button onClick={()=>setError("")}><X size={13}/></button></div>}
          {busy?<LabRunning agents={agents.filter(agent=>selectedAgents.includes(agent.id))}/>:analyses.length?<ComparisonView analyses={analyses} comparison={comparison} onInspect={inspect} selectedId={selectedAnalysis?.run.id}/>:<LabWelcome catalog={catalog}/>} 
        </main>

        <aside className="lab-evidence">
          <EvidencePanel analysis={selectedAnalysis} trace={trace}/>
        </aside>
      </div>

      <BenchmarkStrip benchmarks={catalog?.benchmarks||[]}/>
      {archiveOpen&&<ArchiveDrawer runs={runs} selected={selectedRuns} toggle={toggleRun} compare={compareArchive} busy={busy} close={()=>setArchiveOpen(false)}/>} 
    </section>
  </div>;
}

function AgentToggle({agent,selected,onToggle}){
  const color=ACCENT[agent.accent]||ACCENT.cyan;
  return <button className={`lab-agent-toggle ${selected?"selected":""}`} onClick={onToggle} style={{"--agent":color}}>
    <span className="lab-agent-check">{selected?<Check size={11}/>:null}</span><div><small>{agent.role}</small><strong>{agent.name}</strong><p>{agent.description}</p><div>{agent.modules.slice(0,5).map(id=>{const Icon=MODULE_ICON[id]||Layers3;return <i key={id} title={id.replaceAll("_"," ")}><Icon size={10}/></i>})}{agent.modules.length>5&&<em>+{agent.modules.length-5}</em>}</div></div>
  </button>;
}

function LabWelcome({catalog}){
  return <div className="lab-welcome"><div className="lab-radar"><i/><i/><i/><span><Beaker size={26}/></span></div><small>Comparative agent evaluation</small><h2>See where reliability actually comes from.</h2><p>Run one objective through specialized authority and routing bundles. The lab scores canonical events, not final-answer vibes.</p><div className="lab-capability-grid"><Capability icon={ShieldCheck} title="Policy truth" text="What was allowed or stopped"/><Capability icon={Search} title="Observed reality" text="What tools actually changed"/><Capability icon={GitCompareArrows} title="Causal contrast" text="What differs and what confounds it"/><Capability icon={AlertTriangle} title="Failure intelligence" text="Loops, uncertainty, and false success"/></div><div className="lab-fixture-proof"><strong>{catalog?.benchmarks?.reduce((sum,item)=>sum+(item.trials||0),0)||"—"}</strong><span>frozen trials available as a labelled evidence baseline</span></div></div>;
}
function Capability({icon:Icon,title,text}){return <div><Icon size={14}/><span><strong>{title}</strong><small>{text}</small></span></div>}

function LabRunning({agents}){return <div className="lab-running"><div className="lab-orbit-core"><BrainCircuit size={24}/>{agents.map((agent,index)=><i key={agent.id} style={{"--i":index,"--agent":ACCENT[agent.accent]}}/>)}</div><small>Canonical experiment in progress</small><h2>Same objective. Independent sessions.</h2><p>Each agent is proposing through its own context, authority profile, provider route, observation, and receipt chain.</p><div>{agents.map(agent=><span key={agent.id}><i style={{background:ACCENT[agent.accent]}}/>{agent.name}</span>)}</div></div>}

function ComparisonView({analyses,comparison,onInspect,selectedId}){
  const agentFor=analysis=>analysis.run.labAgentId||analysis.run.profile;
  return <div className="lab-comparison">
    <header><div><small>{comparison?.evidenceClass?.replaceAll("_"," ")||"canonical comparison"}</small><h2>{comparison?.comparable?"Comparable run contrast":"Comparison with confounds"}</h2></div><span className={comparison?.comparable?"clean":"confounded"}>{comparison?.comparable?<><Check size={12}/>objective aligned</>:<><AlertTriangle size={12}/>{comparison?.confounds?.length||0} confounds</>}</span></header>
    {comparison?.confounds?.length>0&&<div className="lab-confounds">{comparison.confounds.map(value=><span key={value}>{value}</span>)}<small>Scores remain visible; causal ranking is withheld.</small></div>}
    <div className="lab-scoreboard">{analyses.map((analysis,index)=><RunCard key={analysis.run.id} analysis={analysis} index={index} active={selectedId===analysis.run.id} onClick={()=>onInspect(analysis)}/>)}</div>
    <section className="lab-matrix"><div className="lab-matrix-head"><div><CircleGauge size={14}/><strong>Mechanism score matrix</strong></div><small>0–100 · evidence-weighted</small></div>{Object.keys(SCORE_LABEL).map(dimension=><ScoreRow key={dimension} dimension={dimension} analyses={analyses} comparison={comparison}/>)}</section>
    <section className="lab-detection-wall"><div className="lab-matrix-head"><div><Activity size={14}/><strong>Automatic findings</strong></div><small>{analyses.reduce((sum,item)=>sum+item.detections.length,0)} signals</small></div><div>{analyses.flatMap(analysis=>analysis.detections.slice(0,3).map(item=><button key={`${analysis.run.id}:${item.code}`} className={item.severity} onClick={()=>onInspect(analysis)}><span>{item.severity==="positive"?<Check size={12}/>:<AlertTriangle size={12}/>}</span><div><small>{agentFor(analysis)}</small><strong>{item.title}</strong><p>{item.detail}</p></div><ChevronRight size={13}/></button>))}</div></section>
  </div>;
}

function RunCard({analysis,index,active,onClick}){
  const color=[ACCENT.cyan,ACCENT.violet,ACCENT.lime][index%3];
  return <button className={`lab-run-card ${active?"active":""}`} onClick={onClick} style={{"--agent":color}}><header><span>{analysis.run.labAgentId?.replaceAll("-"," ")||analysis.run.profile}</span><i className={analysis.run.status}/></header><div className="lab-score-ring" style={{"--score":analysis.scores.composite}}><strong>{analysis.scores.composite}</strong><small>score</small></div><h3>{analysis.run.status.replaceAll("_"," ")}</h3><div className="lab-run-stats"><span><Clock3 size={10}/>{formatDuration(analysis.metrics.durationMs)}</span><span><BrainCircuit size={10}/>{analysis.metrics.modelDecisions} decisions</span><span><Target size={10}/>{analysis.metrics.verifiedActions}/{analysis.metrics.actions} verified</span></div><div className="lab-module-line">{Object.entries(analysis.observedModules).filter(([,value])=>value).slice(0,7).map(([id])=>{const Icon=MODULE_ICON[id]||Layers3;return <i key={id} title={`observed: ${id.replaceAll("_"," ")}`}><Icon size={10}/></i>})}</div></button>;
}

function ScoreRow({dimension,analyses,comparison}){
  const leader=comparison?.dimensions?.[dimension]?.leaderRunId;
  return <div className={`lab-score-row ${dimension==="composite"?"total":""}`}><strong>{SCORE_LABEL[dimension]}</strong><div>{analyses.map((analysis,index)=><span key={analysis.run.id}><i><b style={{width:`${analysis.scores[dimension]}%`,background:[ACCENT.cyan,ACCENT.violet,ACCENT.lime][index%3]}}/></i><em>{analysis.scores[dimension]}</em>{leader===analysis.run.id&&<small>lead</small>}</span>)}</div></div>;
}

function EvidencePanel({analysis,trace}){
  if(!analysis)return <div className="lab-evidence-empty"><Database size={22}/><strong>Evidence inspector</strong><p>Select a scored agent to inspect its declared modules, observed mechanisms, detections, and canonical event sequence.</p></div>;
  return <div className="lab-evidence-panel"><header><div><small>Run evidence</small><strong>{analysis.run.labAgentId?.replaceAll("-"," ")||analysis.run.id}</strong></div><span>{analysis.evidenceClass.replaceAll("_"," ")}</span></header><section><h4>Declared → observed</h4><div className="lab-module-audit">{Object.entries(analysis.observedModules).map(([id,observed])=>{const Icon=MODULE_ICON[id]||Layers3,declared=analysis.declaredModules.includes(id);return <div key={id} className={observed?"observed":""}><Icon size={11}/><span>{id.replaceAll("_"," ")}</span><small>{declared?"declared":"not declared"} · {observed?"exercised":"not exercised"}</small></div>})}</div></section><section><h4>Detected signals</h4><div className="lab-evidence-detections">{analysis.detections.length?analysis.detections.map(item=><details key={item.code} className={item.severity}><summary><span>{item.severity==="positive"?<Check size={10}/>:<AlertTriangle size={10}/>}</span><strong>{item.title}</strong><ChevronDown size={11}/></summary><p>{item.detail}</p><small>events {item.eventSequences.length?item.eventSequences.join(", "):"terminal projection"}</small></details>):<p>No notable mechanism signals were detected.</p>}</div></section><section className="lab-trace"><h4>Canonical trace <span>{trace.length}</span></h4>{trace.length?<div>{trace.map(event=><div key={`${event.sequence}:${event.type}`}><span>{String(event.sequence).padStart(2,"0")}</span><i className={event.type.includes("verified")||event.type.includes("observed")?"truth":event.type.includes("policy")?"policy":""}/><p><strong>{event.type.replaceAll("."," › ")}</strong><small>{traceSummary(event)}</small></p></div>)}</div>:<p>Selecting a live run loads its replayable event chain.</p>}</section><footer><span><Database size={11}/>{analysis.terminalEvidence.length} evidence refs</span><code>{analysis.run.id.slice(0,24)}</code></footer></div>;
}

function BenchmarkStrip({benchmarks}){return <footer className="lab-benchmarks"><div><small>Frozen evaluation shelf</small><strong>Mechanism evidence, clearly separated from live runs</strong></div><div>{benchmarks.map(item=><article key={item.id}><span className={item.passed?"pass":"fail"}>{item.passed?<Check size={10}/>:<X size={10}/>}</span><div><strong>{item.title}</strong><small>{item.trials??"—"} trials · {String(item.evidence_class).replaceAll("_"," ")}</small></div><b>{headlineMetric(item.metrics)}</b></article>)}</div></footer>}

function ArchiveDrawer({runs,selected,toggle,compare,busy,close}){return <div className="lab-archive"><header><div><History size={15}/><span><small>Canonical archive</small><strong>Choose equivalent runs</strong></span></div><button onClick={close}><X size={14}/></button></header><div className="lab-archive-list">{runs.length?runs.map(run=><button key={run.id} className={selected.includes(run.id)?"selected":""} onClick={()=>toggle(run.id)}><span>{selected.includes(run.id)?<Check size={11}/>:null}</span><div><strong>{run.objective}</strong><small>{run.provider} · {run.model||"default"} · {run.profile} · {run.status}</small></div><time>{new Date(run.startedAt).toLocaleDateString()}</time></button>):<p>No persisted runs yet.</p>}</div><footer><p><AlertTriangle size={11}/>The analyzer reports provider, model, profile, and objective confounds.</p><button disabled={selected.length<2||busy} onClick={compare}><GitCompareArrows size={13}/>Compare {selected.length} runs</button></footer></div>}

function formatDuration(ms){if(!ms)return "—";return ms<1000?`${ms}ms`:`${(ms/1000).toFixed(1)}s`}
function headlineMetric(metrics={}){const entry=Object.entries(metrics).find(([,value])=>typeof value==="number");if(!entry)return "verified";const value=entry[1];return value>=0&&value<=1?`${Math.round(value*100)}%`:String(value)}
function traceSummary(event){const payload=event.payload||{};return payload.summary||payload.reason||payload.status||payload.disposition||payload.capabilityId||payload.proposalId||"canonical state transition"}

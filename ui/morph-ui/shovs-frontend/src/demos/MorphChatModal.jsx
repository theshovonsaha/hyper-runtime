import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Braces, Check, ChevronRight, CircleStop, Clock3, Database,
  History, Layers3, ListChecks, Loader2, MessageSquare,
  Search, Send, Sparkles, TerminalSquare, Wrench, X,
} from "lucide-react";
import { BlobAvatar } from "morph-ui/react";

const PHASES = ["intake", "context", "plan", "model", "tool", "verify", "respond", "commit", "done"];
const PHASE_LABEL = { intake:"Intake", context:"Context", plan:"Planning", model:"Thinking", tool:"Using tools", verify:"Verifying", respond:"Responding", commit:"Memory", done:"Complete", error:"Error" };
const PHASE_COLOR = { intake:"#8d84a6", context:"#22c55e", plan:"#8b5cf6", model:"#22d3ee", tool:"#f97316", verify:"#fbbf24", respond:"#a3e635", commit:"#ec4899", done:"#a3e635", error:"#fb7185" };

let sequence = 200;
const id = prefix => `${prefix}-${++sequence}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const EVENT_VIEW = {
  "run.start": { phase:"intake", icon:Sparkles, title:()=>"Opening a transparent run", detail:e=>e.summary || "Freezing the message into an input envelope" },
  capability: { phase:"intake", icon:Layers3, title:()=>"Selecting capabilities", detail:e=>e.summary || "Matching model, tools, and execution strategy" },
  "context.packet": { phase:"context", icon:Database, title:()=>"Packing working context", detail:e=>e.summary || "Selecting relevant history, memory, files, and instructions" },
  "plan.created": { phase:"plan", icon:ListChecks, title:()=>"Planning the work", detail:e=>e.summary || "Breaking the request into observable steps" },
  "plan.update": { phase:"plan", icon:ListChecks, title:()=>"Advancing the plan", detail:e=>e.summary || "Updating step progress from evidence" },
  "model.request": { phase:"model", icon:Sparkles, title:()=>"Thinking with the model", detail:e=>e.summary || "Deciding the next useful action" },
  "model.delta": { phase:"model", icon:Sparkles, title:()=>"Composing the response", detail:e=>(e.payload?.channel === "reasoning" ? "Reasoning through the evidence" : "Writing the answer") },
  "model.response": { phase:"model", icon:Sparkles, title:()=>"Routing the model response", detail:e=>e.summary || "Separating text, decisions, and tool requests" },
  "tool.call": { phase:"tool", icon:Wrench, title:e=>`Calling ${toolName(e)}`, detail:e=>e.summary || "Sending structured arguments to a tool" },
  "tool.stage": { phase:"tool", icon:Loader2, title:e=>e.summary || "Tool is working", detail:e=>stageDetail(e.payload) },
  "tool.result": { phase:"tool", icon:Check, title:e=>`${toolName(e)} returned`, detail:e=>e.summary || "Adapting the result into usable evidence" },
  "verify.verdict": { phase:"verify", icon:ListChecks, title:()=>"Verifying the work", detail:e=>e.summary || "Checking grounding, correctness, and completeness" },
  "respond.final": { phase:"respond", icon:MessageSquare, title:()=>"Delivering the answer", detail:()=>"Turning the completed workflow into a clear response" },
  "memory.commit": { phase:"commit", icon:Database, title:()=>"Updating memory", detail:e=>e.summary || "Saving only durable, relevant context" },
  "run.end": { phase:"done", icon:Check, title:()=>"Run complete", detail:e=>e.summary || "The answer and its full workflow are ready" },
  "run.error": { phase:"error", icon:X, title:()=>"Run needs attention", detail:e=>e.summary || "The runtime reported an error" },
};

function toolName(event) {
  return event.payload?.name || event.payload?.tool || (event.summary || "tool").split("(")[0].replace(/ returned.*$/i, "").trim();
}
function stageDetail(payload={}) {
  if (payload.pages_done != null) return `${payload.pages_done} of ${payload.pages_total || "?"} pages complete`;
  if (payload.progress != null) return `${Math.round(payload.progress * 100)}% complete`;
  return payload.stage || "Processing an intermediate stage";
}
function viewOf(event={}) {
  const adapter = EVENT_VIEW[event.type] || { phase:event.phase || "model", icon:Braces, title:e=>(e.type || "runtime event").replaceAll(".", " › "), detail:e=>e.summary || "Structured runtime event" };
  return { phase:event.phase || adapter.phase, Icon:adapter.icon, title:adapter.title(event), detail:adapter.detail(event) };
}
const INITIAL_MESSAGES = [
  { id:id("msg"), role:"assistant", at:Date.now(), content:"Ask me to research something, inspect a file, or run a multi-step task. Every action will remain visible and navigable." },
];

export function MorphChatModal() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [shape, setShape] = useState("chat");
  const [run, setRun] = useState(null);
  const [pastRuns, setPastRuns] = useState([]);
  const [tab, setTab] = useState("action");
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [backendState, setBackendState] = useState("checking");
  const [sessionId, setSessionId] = useState(() => localStorage.getItem("shovs_session"));
  const abortRef = useRef(null);
  const demoToken = useRef(0);
  const endRef = useRef(null);
  const activeRunIdRef = useRef(null);

  const working = run?.status === "running";
  const events = run?.events || [];
  const currentEvent = events.at(-1);
  const currentView = viewOf(currentEvent || { type:"run.start", summary:"Preparing the next turn" });
  const selectedEvent = events.find(event => event.uiId === selectedEventId) || currentEvent;
  const tools = events.filter(event => event.type?.startsWith("tool."));
  const toolCalls = events.filter(event => event.type === "tool.call");
  const phaseIndex = Math.max(0, PHASES.indexOf(currentView.phase));
  const timelineRuns = [...pastRuns.filter(item => item.id !== run?.id), ...(run ? [run] : [])];

  useEffect(() => {
    fetch("/api/config").then(response => {
      if (!response.ok) throw new Error();
      setBackendState("online");
    }).catch(() => setBackendState("demo"));
  }, []);

  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => setElapsed((Date.now() - run.startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [working, run?.startedAt]);

  useEffect(() => {
    if (shape === "chat") endRef.current?.scrollIntoView({ behavior:"smooth", block:"end" });
  }, [messages, events.length, shape]);

  function beginRun(text, source) {
    const next = { id:id("run"), source, prompt:text, startedAt:Date.now(), status:"running", events:[] };
    activeRunIdRef.current = next.id;
    setMessages(items => [...items, { id:id("msg"), role:"user", content:text, runId:next.id, at:next.startedAt }]);
    setRun(next); setElapsed(0); setSelectedEventId(null); setShape("chat"); setTab("action");
    return next;
  }

  function ingest(event) {
    const normalized = { ...event, uiId:event.uiId || id("event"), at:event.at || Date.now() };
    setRun(previous => previous ? { ...previous, events:[...previous.events, normalized] } : previous);
    setSelectedEventId(normalized.uiId);
    if (event.type === "respond.final" && event.payload?.text) {
      setMessages(items => [...items, { id:id("msg"), role:"assistant", content:event.payload.text, runId:activeRunIdRef.current, at:normalized.at }]);
    }
    if (event.type === "run.end" || event.type === "run.error") {
      setRun(previous => previous ? { ...previous, status:event.type === "run.error" ? "error" : "complete", endedAt:Date.now() } : previous);
    }
    return normalized;
  }

  async function sendMessage({ forceDemo=false }={}) {
    const text = input.trim() || (forceDemo ? "Research the best interface patterns for transparent long-running agents and recommend an implementation." : "");
    if (!text || working) return;
    setInput("");
    const started = beginRun(text, forceDemo ? "guided demo" : "runtime");
    abortRef.current = new AbortController();
    try {
      if (forceDemo) throw new Error("guided-demo");
      const response = await fetch("/api/chat", {
        method:"POST", signal:abortRef.current.signal, headers:{ "content-type":"application/json" },
        body:JSON.stringify({ message:text, session_id:sessionId, level:"debug", auto:true, gate:false }),
      });
      if (!response.ok || !response.body) throw new Error(`runtime returned ${response.status}`);
      setBackendState("online");
      await readSse(response, frame => {
        if (frame.kind === "meta") {
          if (frame.session_id) { setSessionId(frame.session_id); localStorage.setItem("shovs_session", frame.session_id); }
          setRun(previous => previous ? { ...previous, backendId:frame.run_id } : previous);
        } else if (frame.kind === "event") ingest(frame.event);
      });
      setRun(previous => previous?.status === "running" ? { ...previous, status:"complete", endedAt:Date.now() } : previous);
    } catch (error) {
      if (error.name === "AbortError") return;
      setBackendState("demo");
      setRun(previous => previous ? { ...previous, source:forceDemo ? "guided demo" : "guided fallback" } : previous);
      await runGuidedDemo(started, text);
    }
  }

  async function runGuidedDemo(started, text) {
    const token = ++demoToken.current;
    const emit = async (delay, type, phase, summary, payload={}) => {
      await wait(delay);
      if (token !== demoToken.current) throw new DOMException("Stopped", "AbortError");
      ingest({ type, phase, summary, payload, run_id:started.id });
    };
    try {
      await emit(750,"run.start","intake","Input envelope created",{ source:"chat", chars:text.length, inspection_level:"debug" });
      await emit(1100,"capability","intake","scaffolded · reasoning · web tools",{ driver:false, reasoning:true, vision:false, tools:["web_search","web_fetch"] });
      await emit(1400,"context.packet","context","7/9 items · 11.2k chars",{ items_included:7, items_total:9, chars:11240, sources:{ system:2, history:3, memory:2 }, dropped:["stale turn","unrelated note"] });
      await emit(1500,"plan.created","plan","Created a 4-step evidence plan",{ steps:[{id:1,text:"Search current interface patterns",status:"active"},{id:2,text:"Read primary sources",status:"pending"},{id:3,text:"Compare interaction models",status:"pending"},{id:4,text:"Verify and recommend",status:"pending"}] });
      await emit(1250,"model.request","model","Choosing the first research query",{ model:"runtime-selected", intent:"find current primary-source patterns" });
      await emit(1350,"tool.call","tool","web_search({query, freshness, limit})",{ id:"search-1", name:"web_search", arguments:{ query:"transparent long-running agent interface patterns", freshness:"recent", limit:6 } });
      await emit(1750,"tool.stage","tool","Searching configured providers",{ id:"search-1", stage:"retrieval", provider:"auto", progress:0.48 });
      await emit(1850,"tool.result","tool","web_search returned 6 sources",{ id:"search-1", name:"web_search", ok:true, duration_ms:1814, result_count:6, domains:["openai.com","anthropic.com","microsoft.com"], results:[{title:"Building transparent agent experiences",domain:"openai.com",relevance:0.96},{title:"Tool use and user control",domain:"anthropic.com",relevance:0.91},{title:"Human-agent interaction patterns",domain:"microsoft.com",relevance:0.87}] });
      await emit(1200,"plan.update","plan","Search complete · source reading active",{ step_id:1,status:"done",steps:[{id:1,text:"Search current interface patterns",status:"done"},{id:2,text:"Read primary sources",status:"active"},{id:3,text:"Compare interaction models",status:"pending"},{id:4,text:"Verify and recommend",status:"pending"}] });
      await emit(1400,"tool.call","tool","web_fetch({urls, extract})",{ id:"fetch-1", name:"web_fetch", arguments:{ urls:["https://openai.com/research","https://anthropic.com/research","https://microsoft.com/research"], extract:"interaction patterns, progress disclosure, failure handling" } });
      await emit(1900,"tool.stage","tool","Reading and structuring source 2 of 3",{ id:"fetch-1", stage:"semantic extraction", pages_done:2, pages_total:3 });
      await emit(2000,"tool.result","tool","3 sources structured into comparable signals",{ id:"fetch-1",name:"web_fetch",ok:true,duration_ms:2470,patterns:[{name:"progressive disclosure",score:0.96},{name:"persistent interruptibility",score:0.92},{name:"typed event history",score:0.9},{name:"raw data escape hatch",score:0.84}], insight:"Users need a calm summary first and complete provenance on demand." });
      await emit(1500,"verify.verdict","verify","Evidence grounded · no contradictions found",{ verdict:"accept",confidence:0.93,checks:{ primary_sources:true, tool_evidence:true, contradictions:false, user_goal:true } });
      const answer="Use one shape-changing parent: the input becomes a stable live-agent capsule, and that capsule expands into the complete turn. Keep current action visible at a glance; place chat history, tool calls, and adapted event data one click deeper. Preserve raw JSON as an escape hatch, not the default presentation.";
      await emit(1100,"respond.final","respond","Recommendation composed",{ text:answer });
      await emit(900,"memory.commit","commit","Saved your interface preference",{ policy:"explicit preference", facts:["prefers transparent workflows","prefers morphing components","wants navigable tool details"] });
      await emit(800,"run.end","done","Completed guided agent run",{ status:"completed",duration_ms:Date.now()-started.startedAt,usage:{input_tokens:1840,output_tokens:226} });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }

  function stopRun() {
    demoToken.current += 1;
    abortRef.current?.abort();
    setRun(previous => previous ? { ...previous, status:"stopped", endedAt:Date.now() } : previous);
  }

  useEffect(() => {
    if (!run || run.status === "running") return;
    setPastRuns(items => items.some(item => item.id === run.id) ? items : [...items, run]);
  }, [run]);

  function inspectEvent(event, sourceRun, nextTab=event.type?.startsWith("tool.") ? "tools" : "data") {
    if (sourceRun && sourceRun.id !== run?.id) { setRun(sourceRun); activeRunIdRef.current=sourceRun.id; }
    setSelectedEventId(event.uiId); setTab(nextTab); setShape("inspect");
  }

  return (
    <div className="mcm-stage">
      <section className={`mcm-shell shape-${shape} ${working ? "is-working" : "is-idle"}`} style={{ "--mcm-phase":PHASE_COLOR[currentView.phase] || PHASE_COLOR.model }}>
        <div className="mcm-shape-code" aria-hidden="true"><span>[~]</span><ChevronRight size={12}/><span className={working ? "active":""}>[{`{~}`} ]</span><ChevronRight size={12}/><span className={shape === "inspect" ? "active":""}>{`{[…]}`}</span></div>

        {shape === "inspect" ? (
          <Inspector
            tab={tab} setTab={setTab} messages={messages} events={events} tools={tools}
            selectedEvent={selectedEvent} selectEvent={setSelectedEventId} currentView={currentView}
            run={run} elapsed={elapsed} pastRuns={pastRuns} onClose={()=>setShape("chat")}
          />
        ) : (
          <>
            <header className="mcm-header">
              <div className="mcm-avatar-wrap"><BlobAvatar state={working ? "running":"idle"} size={38}/></div>
              <div className="mcm-title"><h2>Transparent agent</h2><p><span className={`mcm-backend-dot ${backendState}`}/>{backendState === "online" ? "runtime connected" : backendState === "checking" ? "checking runtime" : "guided demo fallback"}</p></div>
              <button className="mcm-icon-btn" onClick={()=>{setTab("history");setShape("inspect");}} title="Open turn history"><History size={15}/></button>
            </header>

            <ChatTimeline messages={messages} runs={timelineRuns} working={working} onInspect={inspectEvent} endRef={endRef}/>

            <div className={`mcm-parent-shape ${working ? "agent":"input"}`}>
              {working ? (
                <AgentCapsule view={currentView} elapsed={elapsed} phaseIndex={phaseIndex} events={events} tools={toolCalls.length} onOpen={()=>{setTab("action");setShape("inspect");}} onStop={stopRun}/>
              ) : (
                <div className="mcm-input-shape">
                  <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key === "Enter" && !e.shiftKey){e.preventDefault();sendMessage();}}} placeholder="Ask for a multi-step task…" rows={1}/>
                  <button className="mcm-demo-button" onClick={()=>sendMessage({forceDemo:true})} title="Run paced workflow demo"><Sparkles size={13}/> Demo</button>
                  <button className="mcm-send" onClick={()=>sendMessage()} disabled={!input.trim()} aria-label="Send"><Send size={16}/></button>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

async function readSse(response, onFrame) {
  const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer="";
  while (true) {
    const {done,value}=await reader.read(); if(done) break;
    buffer += decoder.decode(value,{stream:true}); let boundary;
    while((boundary=buffer.indexOf("\n\n"))>=0){
      const frame=buffer.slice(0,boundary); buffer=buffer.slice(boundary+2);
      for(const line of frame.split("\n")) if(line.startsWith("data:")) onFrame(JSON.parse(line.slice(5)));
    }
  }
}

function AgentCapsule({ view, elapsed, phaseIndex, events, tools, onOpen, onStop }) {
  const Icon=view.Icon;
  return <div className="mcm-agent-capsule">
    <button className="mcm-agent-main" onClick={onOpen}>
      <span className="mcm-orb"><BlobAvatar state="running" size={48}/><span className="mcm-orbit"/></span>
      <span className="mcm-agent-copy"><span className="mcm-agent-kicker"><span className="mcm-live-dot"/>{PHASE_LABEL[view.phase] || view.phase} · live</span><strong><Icon size={14}/>{view.title}</strong><small>{view.detail}</small></span>
    </button>
    <div className="mcm-agent-controls"><span><Clock3 size={11}/>{elapsed.toFixed(1)}s</span><span>{events.length} events</span><span>{tools} tools</span><button onClick={onOpen} aria-label="Expand agent"><ChevronRight size={16}/></button><button onClick={onStop} aria-label="Stop run"><CircleStop size={16}/></button></div>
    <div className="mcm-phase-rail" aria-label="Agent progress">{PHASES.map((phase,index)=><i key={phase} className={index < phaseIndex ? "done" : index === phaseIndex ? "active":""} title={phase}/>)}</div>
  </div>;
}

function ChatTimeline({ messages, runs, working, onInspect, endRef }) {
  const ungrouped=messages.filter(message=>!message.runId);
  return <div className="mcm-chat-timeline">
    {ungrouped.map(message=><div key={message.id} className={`mcm-bubble ${message.role}`}>{message.content}</div>)}
    {runs.map((item,index)=>{
      const runMessages=messages.filter(message=>message.runId===item.id), visibleEvents=item.events.filter(event=>!["model.delta","respond.final"].includes(event.type));
      return <React.Fragment key={item.id}>{runMessages.filter(message=>message.role==="user").map(message=><div key={message.id} className="mcm-bubble user">{message.content}</div>)}{visibleEvents.length>0&&<div className="mcm-workflow-stack"><div className="mcm-workflow-label"><span>agent workflow · {item.source}</span><span>{visibleEvents.length} events</span></div>{visibleEvents.map(event=><WorkflowRow key={event.uiId} event={event} active={working&&index===runs.length-1&&event===visibleEvents.at(-1)} onClick={()=>onInspect(event,item)}/>)}</div>}{runMessages.filter(message=>message.role==="assistant").map(message=><div key={message.id} className="mcm-bubble assistant">{message.content}</div>)}</React.Fragment>;
    })}
    <div ref={endRef}/>
  </div>;
}

function WorkflowRow({event,active,onClick}) {
  const view=viewOf(event), Icon=view.Icon;
  return <button className={`mcm-workflow-row ${active ? "active":""}`} onClick={onClick} style={{"--event-color":PHASE_COLOR[view.phase]}}>
    <span className="mcm-event-glyph"><Icon size={12}/></span><span className="mcm-event-copy"><strong>{view.title}</strong><small>{view.detail}</small></span><span className="mcm-event-time">{stampFrom(event.at)}</span><ChevronRight size={13}/>
  </button>;
}

function Inspector({tab,setTab,messages,events,tools,selectedEvent,selectEvent,currentView,run,elapsed,onClose}) {
  const tabs=[{id:"history",label:"Chat history",Icon:History,count:messages.length},{id:"tools",label:"Tools called",Icon:Wrench,count:events.filter(e=>e.type==="tool.call").length},{id:"action",label:"Current action",Icon:Sparkles},{id:"data",label:"Event data",Icon:Braces,count:events.length}];
  return <div className="mcm-inspector">
    <header className="mcm-inspector-head"><button className="mcm-back" onClick={onClose}><ArrowLeft size={15}/></button><div><span>Inside this turn</span><small>{run?.source || "runtime"} · {run?.status || "ready"}</small></div><button className="mcm-icon-btn" onClick={onClose}><X size={15}/></button></header>
    <nav className="mcm-inspector-tabs">{tabs.map(({id:tabId,label,Icon,count})=><button key={tabId} className={tab===tabId?"active":""} onClick={()=>setTab(tabId)}><Icon size={13}/><span>{label}</span>{count!=null&&<b>{count}</b>}</button>)}</nav>
    <main className="mcm-inspector-body">
      {tab==="history"&&<HistoryPanel messages={messages} events={events} onInspect={event=>{selectEvent(event.uiId);setTab(event.type?.startsWith("tool.")?"tools":"data");}}/>}
      {tab==="tools"&&<ToolPanel tools={tools} selectedEvent={selectedEvent} selectEvent={selectEvent}/>} 
      {tab==="action"&&<ActionPanel view={currentView} events={events} run={run} elapsed={elapsed}/>} 
      {tab==="data"&&<DataPanel events={events} selectedEvent={selectedEvent} selectEvent={selectEvent}/>} 
    </main>
  </div>;
}

function HistoryPanel({messages,events,onInspect}) {
  const items=[...messages.map(message=>({...message,kind:"message",at:message.at||0})),...events.filter(e=>e.type!=="model.delta").map(event=>({...event,kind:"event"}))].sort((a,b)=>(a.at||0)-(b.at||0));
  return <div className="mcm-history-panel">{items.map(item=>item.kind==="event"?<WorkflowRow key={item.uiId} event={item} onClick={()=>onInspect(item)}/>:<div key={item.id} className={`mcm-history-message ${item.role}`}><span>{item.role}</span><p>{item.content}</p></div>)}</div>;
}

function ToolPanel({tools,selectedEvent,selectEvent}) {
  const chosen=(selectedEvent?.type?.startsWith("tool.")&&selectedEvent)||tools.at(-1);
  return <div className="mcm-split-panel"><aside>{tools.length?tools.map(event=><WorkflowRow key={event.uiId} event={event} active={event.uiId===chosen?.uiId} onClick={()=>selectEvent(event.uiId)}/>):<EmptyState icon={Wrench} text="Tool calls will appear here with their stages and results."/>}</aside><section>{chosen?<EventDetail event={chosen}/>:<EmptyState icon={Search} text="Select a tool call to inspect it."/>}</section></div>;
}

function DataPanel({events,selectedEvent,selectEvent}) {
  const chosen=selectedEvent||events.at(-1);
  return <div className="mcm-split-panel"><aside>{events.filter(e=>e.type!=="model.delta").map(event=><WorkflowRow key={event.uiId} event={event} active={event.uiId===chosen?.uiId} onClick={()=>selectEvent(event.uiId)}/>)}</aside><section>{chosen?<EventDetail event={chosen}/>:<EmptyState icon={Braces} text="Runtime event data will appear here."/>}</section></div>;
}

function ActionPanel({view,events,run,elapsed}) {
  const Icon=view.Icon, calls=events.filter(e=>e.type==="tool.call").length, completed=events.filter(e=>e.type==="tool.result").length;
  const plan=[...events].reverse().find(e=>e.payload?.steps)?.payload?.steps || [];
  return <div className="mcm-action-panel"><div className="mcm-action-hero"><span className="mcm-action-orb"><BlobAvatar state={run?.status==="running"?"running":"idle"} size={56}/></span><div><small>{PHASE_LABEL[view.phase]||view.phase} · {run?.status}</small><h2><Icon size={19}/>{view.title}</h2><p>{view.detail}</p></div></div><div className="mcm-insight-grid"><Insight value={`${elapsed.toFixed(1)}s`} label="elapsed"/><Insight value={events.length} label="events"/><Insight value={`${completed}/${calls}`} label="tools returned"/><Insight value={run?.source||"runtime"} label="execution source"/></div>{plan.length>0&&<PlanView steps={plan}/>}<div className="mcm-action-feed">{events.slice(-5).reverse().map(event=><WorkflowRow key={event.uiId} event={event}/>)}</div></div>;
}

function EventDetail({event}) {
  const view=viewOf(event), Icon=view.Icon;
  return <article className="mcm-event-detail"><header style={{"--event-color":PHASE_COLOR[view.phase]}}><span><Icon size={17}/></span><div><small>{event.type}</small><h3>{view.title}</h3><p>{view.detail}</p></div></header><PayloadAdapter payload={event.payload||{}} event={event}/></article>;
}

function PayloadAdapter({payload,event}) {
  const [raw,setRaw]=useState(false);
  const content=raw?<pre className="mcm-json-raw">{JSON.stringify(payload,null,2)}</pre>:adaptPayload(payload,event);
  return <div className="mcm-payload"><div className="mcm-payload-bar"><span>Visual interpretation</span><button onClick={()=>setRaw(value=>!value)}><Braces size={12}/>{raw?"insight view":"raw JSON"}</button></div>{content}</div>;
}
function adaptPayload(payload,event) {
  if(Array.isArray(payload.steps)) return <PlanView steps={payload.steps}/>;
  if(Array.isArray(payload.results)||payload.result_count!=null) return <SearchResultsView payload={payload}/>;
  if(payload.checks||payload.verdict) return <VerificationView payload={payload}/>;
  if(payload.arguments||event.type==="tool.call") return <ToolRequestView payload={payload}/>;
  if(Array.isArray(payload.patterns)) return <PatternView payload={payload}/>;
  if(payload.sources||payload.items_included!=null) return <ContextView payload={payload}/>;
  return <NaturalObject value={payload}/>;
}

function PlanView({steps=[]}) { return <div className="mcm-plan-view"><h4><ListChecks size={14}/>Execution plan</h4>{steps.map((step,index)=><div key={step.id||index} className={`mcm-plan-step ${step.status||"pending"}`}><span>{step.status==="done"?<Check size={12}/>:index+1}</span><p>{step.text||step.title||String(step)}</p><small>{step.status||"pending"}</small></div>)}</div>; }
function SearchResultsView({payload}) { const results=payload.results||[]; return <div><div className="mcm-adapter-summary"><Insight value={payload.result_count??results.length} label="sources found"/><Insight value={payload.duration_ms?`${payload.duration_ms}ms`:"—"} label="retrieval time"/><Insight value={payload.domains?.length||new Set(results.map(r=>r.domain)).size} label="domains"/></div><div className="mcm-source-list">{results.map((result,index)=><div key={index}><span>{index+1}</span><div><strong>{result.title||result.name||"Source"}</strong><small>{result.domain||result.url}</small></div>{result.relevance!=null&&<b>{Math.round(result.relevance*100)}%</b>}</div>)}</div>{payload.insight&&<blockquote>{payload.insight}</blockquote>}</div>; }
function VerificationView({payload}) { return <div><div className={`mcm-verdict ${payload.verdict||"accept"}`}><Check size={16}/><div><strong>{payload.verdict||"verified"}</strong><small>{payload.confidence!=null?`${Math.round(payload.confidence*100)}% confidence`:"deterministic checks complete"}</small></div></div><div className="mcm-check-grid">{Object.entries(payload.checks||{}).map(([key,value])=><div key={key} className={value?"pass":"fail"}>{value?<Check size={12}/>:<X size={12}/>}<span>{key.replaceAll("_"," ")}</span></div>)}</div></div>; }
function ToolRequestView({payload}) { return <div><div className="mcm-tool-signature"><TerminalSquare size={16}/><div><small>tool request</small><strong>{payload.name||payload.tool||"tool"}</strong></div></div><NaturalObject value={payload.arguments||payload}/></div>; }
function PatternView({payload}) { return <div className="mcm-patterns">{payload.patterns.map((pattern,index)=>{const item=typeof pattern==="string"?{name:pattern}:pattern;return <div key={index}><span>{item.name}</span>{item.score!=null&&<i><b style={{width:`${item.score*100}%`}}/></i>}<strong>{item.score!=null?`${Math.round(item.score*100)}%`:""}</strong></div>})}{payload.insight&&<blockquote>{payload.insight}</blockquote>}</div>; }
function ContextView({payload}) { const sources=payload.sources||{}; return <div><div className="mcm-adapter-summary"><Insight value={`${payload.items_included??"?"}/${payload.items_total??"?"}`} label="context items"/><Insight value={payload.chars?`${(payload.chars/1000).toFixed(1)}k`:"—"} label="characters"/><Insight value={payload.dropped?.length||0} label="items dropped"/></div><div className="mcm-context-bars">{Object.entries(sources).map(([name,value])=><div key={name}><span>{name}</span><i><b style={{width:`${Math.min(100,Number(value)*22)}%`}}/></i><strong>{String(value)}</strong></div>)}</div></div>; }

function NaturalObject({value,depth=0}) {
  if(value==null) return <span className="mcm-scalar null">null</span>;
  if(typeof value!=="object") return <span className={`mcm-scalar ${typeof value}`}>{String(value)}</span>;
  if(Array.isArray(value)) return <div className="mcm-natural-list">{value.map((item,index)=><div key={index}><span>{index+1}</span><NaturalObject value={item} depth={depth+1}/></div>)}</div>;
  return <dl className={`mcm-natural-object depth-${Math.min(depth,2)}`}>{Object.entries(value).map(([key,item])=><div key={key}><dt>{key.replaceAll("_"," ")}</dt><dd><NaturalObject value={item} depth={depth+1}/></dd></div>)}</dl>;
}
function Insight({value,label}) { return <div className="mcm-insight"><strong>{value}</strong><span>{label}</span></div>; }
function EmptyState({icon:Icon,text}) { return <div className="mcm-empty"><Icon size={22}/><p>{text}</p></div>; }
function stampFrom(value) { if(!value)return ""; return new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}); }

import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Braces, Check, ChevronDown, ChevronRight, CircleStop, Clock3, Database,
  Eye, FileText, Folder, FolderOpen, History, Layers3, Link2, ListChecks, Loader2, MessageSquare, Paperclip, Pencil, Plus, RotateCw,
  Search, Send, Server, Settings2, Sparkles, TerminalSquare, Trash2, Wrench, X,
} from "lucide-react";
import { BlobAvatar } from "morph-ui/react";
import { loadChatSessions, persistChatSessions } from "../store/chatSessionStorage.js";

const PHASES = ["intake", "context", "gate", "plan", "model", "tool", "verify", "respond", "commit", "done"];
const PHASE_LABEL = { intake:"Intake", context:"Context", gate:"Approval", plan:"Planning", model:"Thinking", tool:"Using tools", verify:"Verifying", respond:"Responding", commit:"Receipt", done:"Complete", error:"Error" };
const PHASE_COLOR = { intake:"#8d84a6", context:"#22c55e", gate:"#fbbf24", plan:"#8b5cf6", model:"#22d3ee", tool:"#f97316", verify:"#fbbf24", respond:"#a3e635", commit:"#ec4899", done:"#a3e635", error:"#fb7185" };

const id = prefix => `${prefix}:${crypto.randomUUID()}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const EVENT_VIEW = {
  "run.start": { phase:"intake", icon:Sparkles, title:()=>"Opening a transparent run", detail:e=>e.summary || "Freezing the message into an input envelope" },
  capability: { phase:"intake", icon:Layers3, title:()=>"Selecting capabilities", detail:e=>e.summary || "Matching model, tools, and execution strategy" },
  "context.packet": { phase:"context", icon:Database, title:()=>"Packing working context", detail:e=>e.summary || "Selecting relevant history, memory, files, and instructions" },
  "gate.open": { phase:"gate", icon:CircleStop, title:()=>"Waiting for operator approval", detail:e=>e.summary || "A risky action is paused at the policy boundary" },
  "gate.resolved": { phase:"gate", icon:Check, title:()=>"Approval gate resolved", detail:e=>e.summary || "The operator resolved the scoped action" },
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
  "receipt.commit": { phase:"commit", icon:Database, title:()=>"Committing the receipt", detail:e=>e.summary || "Persisting the evidence-linked terminal outcome" },
  "run.end": { phase:"done", icon:Check, title:()=>"Run complete", detail:e=>e.summary || "The answer and its full workflow are ready" },
  "run.pause": { phase:"gate", icon:MessageSquare, title:()=>"Waiting for your reply", detail:e=>e.summary || "The workflow paused for information only you can provide" },
  "run.cancelled": { phase:"done", icon:CircleStop, title:()=>"Run cancelled cleanly", detail:e=>e.summary || "Completed effects and evidence were retained" },
  "artifact.ready": { phase:"commit", icon:FileText, title:()=>"Generated artifact is ready", detail:e=>e.summary || "The verified output is available in session files" },
  "run.error": { phase:"error", icon:X, title:()=>"Run needs attention", detail:e=>e.summary || "The runtime reported an error" },
  "model.proposed": { phase:"model", icon:Sparkles, title:()=>"Model proposed the next move", detail:()=>"A suggestion only; policy has not authorized it" },
  "policy.decided": { phase:"gate", icon:CircleStop, title:()=>"Policy evaluated authority", detail:e=>(e.payload?.disposition ? `${e.payload.disposition} · ${(e.payload.reasonCodes||[]).join(", ")}` : "Checking scope, conditions, effects, risk, and approval") },
  "action.executed": { phase:"tool", icon:Wrench, title:()=>"Capability reported an execution result", detail:e=>e.payload?.summary || "This report is not completion until observed and verified" },
  "state.observed": { phase:"verify", icon:Search, title:()=>"Runtime observed actual state", detail:e=>e.payload?.target || "Reading the environment independently of the model" },
  "action.verified": { phase:"verify", icon:ListChecks, title:()=>"Runtime checked the outcome", detail:e=>(e.payload?.passed ? "Observed evidence passed the declared verifier" : "The claimed outcome was not established") },
  "effect.reconciled": { phase:"verify", icon:RotateCw, title:()=>"Uncertain effect reconciled", detail:e=>e.payload?.summary || "Observed whether an interrupted effect was applied before any retry" },
  "effect.reconciliation_failed": { phase:"error", icon:X, title:()=>"Effect remains uncertain", detail:()=>"The runtime will not blindly repeat this action" },
  "workflow.node_started": { phase:"plan", icon:ListChecks, title:e=>`Starting ${e.payload?.kind || "workflow"} node`, detail:e=>e.payload?.nodeId || "Bounded workflow composition" },
  "workflow.node_finished": { phase:"plan", icon:Check, title:e=>`${e.payload?.kind || "Workflow"} node ${e.payload?.status || "finished"}`, detail:e=>(e.payload?.reasonCodes||[]).join(", ") },
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
  return {
    phase:event.phase || adapter.phase,
    Icon:adapter.icon,
    title:event.title || adapter.title(event),
    detail:event.detail || event.summary || adapter.detail(event),
  };
}
function localEventState(event={}) {
  if(event.type==="run.error"||event.phase==="error"||event.type==="tool.result"&&event.payload?.ok===false)return "error";
  if(event.type==="gate.open"||event.type==="run.pause")return "pending";
  if(event.type==="tool.call"||event.type==="model.request")return "running";
  if(event.type==="verify.verdict")return event.payload?.passed===false||event.payload?.verdict==="reject"?"error":"success";
  if(["run.end","tool.result","respond.final","receipt.commit","memory.commit"].includes(event.type))return "success";
  return "info";
}
function normalizeUiEvent(event={}) {
  const evidence=[...(event.payload?.evidenceRefs||[]),...(event.payload?.evidence||[]).flatMap(item=>typeof item==="string"?[item]:item?.id?[item.id]:[])];
  return {
    ...event,
    uiId:event.id||event.uiId||id("event"),
    at:event.at||Date.now(),
    state:event.state||localEventState(event),
    lens:event.lens||eventLens(event),
    correlation:event.correlation||{evidence_refs:[...new Set(evidence)]},
  };
}
const initialMessages = () => [
  { id:id("msg"), role:"assistant", at:Date.now(), content:"Tell me the outcome you need. I’ll choose the approach, use the right tools, and verify the work before calling it done." },
];
const API_BASE_KEY = "hyper_api_base";
const MODEL_KEY = "hyper_model";
const PROVIDER_KEY = "hyper_provider";
const ROUTING_KEY = "hyper_model_routing";
const ROUTES_KEY = "hyper_model_routes";
const RUN_MODE_KEY = "hyper_run_mode";
const REASONING_KEY = "hyper_reasoning_effort";
const ROUTE_COUNTS = { ping_pong:2, ring:3, ring_pair:4, round_robin:2 };
const ROUTING_LABEL = {
  fallback:"Primary, then fallbacks", ping_pong:"Ping-pong · 2 model pairs",
  ring:"Ring · 3 model pairs", ring_pair:"Ring pair · 4 model pairs",
  round_robin:"Rotate configured routes",
};

function storedRoutes() {
  try {
    const value=JSON.parse(localStorage.getItem(ROUTES_KEY)||"[]");
    return Array.isArray(value)?value.filter(route=>route?.provider&&route?.model).slice(0,4):[];
  } catch { return []; }
}

function RoutingRouteField({index,route,providers,apiBase,onChange,onRemove}) {
  const [models,setModels]=useState([]),[state,setState]=useState("idle");
  useEffect(()=>{
    if(!route.provider)return;
    let active=true;setState("loading");
    fetch(`${apiBase.replace(/\/$/,"")}/api/models/${encodeURIComponent(route.provider)}`,{signal:AbortSignal.timeout(6500)})
      .then(async response=>{const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error();return value;})
      .then(value=>{if(!active)return;const list=(value.models||[]).filter(item=>item?.id);setModels(list);setState("ready");if(!route.model)onChange({...route,model:value.default_model||list[0]?.id||""});})
      .catch(()=>{if(active){setModels([]);setState("error");}});
    return()=>{active=false;};
  },[route.provider]);
  const known=models.some(item=>item.id===route.model);
  return <div className="mcm-route-pair"><b>{String.fromCharCode(65+index)}</b><select value={route.provider} onChange={event=>{const provider=providers.find(item=>item.id===event.target.value);onChange({provider:event.target.value,model:provider?.default_model||""});}}>{providers.filter(item=>item.configured).map(item=><option value={item.id} key={item.id}>{item.label||item.id}{item.connected===false?" · offline":""}</option>)}</select><select value={known?route.model:"__custom__"} disabled={state==="loading"} onChange={event=>onChange({...route,model:event.target.value==="__custom__"?"":event.target.value})}><option value="__custom__">{state==="loading"?"Loading…":"Custom model…"}</option>{models.map(item=><option value={item.id} key={item.id}>{item.name||item.id}</option>)}</select>{!known&&<input value={route.model} onChange={event=>onChange({...route,model:event.target.value})} placeholder="Model ID"/>}{onRemove&&<button type="button" onClick={onRemove} title="Remove fallback route" aria-label={`Remove route ${String.fromCharCode(65+index)}`}><X size={13}/></button>}</div>;
}

function freshSession() {
  return { id:`local:${crypto.randomUUID()}`, title:"New chat", backendSessionId:null, messages:initialMessages(), runs:[], updatedAt:Date.now() };
}

function uniqueMessages(messages=[]) {
  const seen=new Set();
  return messages.map(message=>{
    const messageId=typeof message.id==="string"&&message.id&&!seen.has(message.id)?message.id:id("msg");
    seen.add(messageId);
    return messageId===message.id?message:{...message,id:messageId};
  });
}

function storedSessions() {
  const parsed=loadChatSessions(localStorage);
  return parsed.length
    ? parsed.map(session=>({...session,messages:uniqueMessages(session.messages)}))
    : [freshSession()];
}

export function MorphChatModal() {
  const [sessions, setSessions] = useState(storedSessions);
  const [activeSessionId, setActiveSessionId] = useState(() => localStorage.getItem("hyper_active_chat"));
  const initialSession = sessions.find(item=>item.id===activeSessionId) || sessions[0];
  const [messages, setMessages] = useState(initialSession.messages?.length ? uniqueMessages(initialSession.messages) : initialMessages());
  const [input, setInput] = useState("");
  const [shape, setShape] = useState("chat");
  const [run, setRun] = useState(null);
  const [pastRuns, setPastRuns] = useState(initialSession.runs || []);
  const [tab, setTab] = useState("action");
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [backendState, setBackendState] = useState("checking");
  const [backendInfo, setBackendInfo] = useState(null);
  const [backendError, setBackendError] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiBase, setApiBase] = useState(() => localStorage.getItem(API_BASE_KEY) || "");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(MODEL_KEY) || "");
  const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem(PROVIDER_KEY) || "");
  const [routingMode, setRoutingMode] = useState(() => localStorage.getItem(ROUTING_KEY) || "fallback");
  const [routingRoutes, setRoutingRoutes] = useState(storedRoutes);
  const [agentAutonomous, setAgentAutonomous] = useState(Boolean(initialSession.agent?.autonomous));
  const [autoMode, setAutoMode] = useState(Boolean(initialSession.agent?.autoMode));
  const [autoMaxSteps, setAutoMaxSteps] = useState(initialSession.agent?.autoMaxSteps || 24);
  const [agentInstructions, setAgentInstructions] = useState(initialSession.agent?.instructions || "");
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [modelOptions, setModelOptions] = useState([]);
  const [modelsState, setModelsState] = useState("idle");
  const [modelsError, setModelsError] = useState("");
  const [pendingApproval, setPendingApproval] = useState(null);
  const [operatorPanel, setOperatorPanel] = useState(null);
  const [profile, setProfile] = useState(() => localStorage.getItem("hyper_profile") || "inspect");
  const [runMode, setRunMode] = useState(() => localStorage.getItem(RUN_MODE_KEY) || "auto");
  const [reasoningEffort, setReasoningEffort] = useState(() => localStorage.getItem(REASONING_KEY) || "auto");
  const [sessionId, setSessionId] = useState(initialSession.backendSessionId || null);
  const [attachments, setAttachments] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [embeddingState, setEmbeddingState] = useState({profile_id:"lexical",profiles:[],locked_at:null});
  const [linkedFiles, setLinkedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [editingMessage, setEditingMessage] = useState(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const demoToken = useRef(0);
  const timelineRef = useRef(null);
  const followTimelineRef = useRef(true);
  const activeRunIdRef = useRef(null);
  const activeBackendRunIdRef = useRef(null);
  const bootedRef = useRef(false);

  const working = run?.status === "running" || run?.status === "cancelling";
  const events = run?.events || [];
  const currentEvent = events.at(-1);
  const currentView = viewOf(currentEvent || { type:"run.start", summary:"Preparing the next turn" });
  const selectedEvent = events.find(event => event.uiId === selectedEventId) || currentEvent;
  const tools = events.filter(event => event.type?.startsWith("tool."));
  const toolCalls = events.filter(event => event.type === "tool.call");
  const phaseIndex = Math.max(0, PHASES.indexOf(currentView.phase));
  const timelineRuns = [...pastRuns.filter(item => item.id !== run?.id), ...(run ? [run] : [])];

  const apiUrl = (path, base=apiBase) => `${base.replace(/\/$/, "")}${path}`;
  const activeRouteCount = () => routingMode==="fallback"
    ? Math.max(1,Math.min(4,routingRoutes.length||1))
    : ROUTE_COUNTS[routingMode]||1;
  const activeRoutingRoutes = () => {
    const count=activeRouteCount();
    return Array.from({length:count},(_,index)=>index===0
      ? {provider:selectedProvider,model:selectedModel}
      : routingRoutes[index]||{provider:"",model:""}).filter(route=>route.provider&&route.model);
  };
  const chooseRoutingMode = mode => {
    setRoutingMode(mode);localStorage.setItem(ROUTING_KEY,mode);
    const count=ROUTE_COUNTS[mode]||1;
    setRoutingRoutes(current=>Array.from({length:count},(_,index)=>{
      if(index===0)return {provider:selectedProvider,model:selectedModel};
      if(current[index]?.provider&&current[index]?.model)return current[index];
      const used=new Set([selectedProvider,...current.slice(1,index).map(route=>route?.provider)]);
      const provider=providerCatalog.find(item=>item.configured&&!used.has(item.id))||providerCatalog.find(item=>item.configured);
      return {provider:provider?.id||"",model:provider?.default_model||""};
    }));
  };

  async function loadProviderModels(providerId, base=apiBase, fallbackModel="") {
    if (!providerId) return;
    setModelsState("loading"); setModelsError("");
    try {
      const response=await fetch(apiUrl(`/api/models/${encodeURIComponent(providerId)}`,base),{signal:AbortSignal.timeout(6500)});
      const data=await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(data.error || `model discovery returned ${response.status}`);
      const models=(data.models||[]).filter(item=>item?.id);
      setModelOptions(models);
      setSelectedModel(current=>models.length
        ? ([current,data.default_model,fallbackModel].find(candidate=>models.some(item=>item.id===candidate)) || models[0]?.id || "")
        : current || data.default_model || fallbackModel || "");
      setModelsState("ready");
    } catch (error) {
      setModelOptions([]);
      setModelsError(error.message || "Could not discover models");
      setSelectedModel(current=>current || fallbackModel);
      setModelsState("error");
    }
  }

  async function chooseProvider(providerId, base=apiBase) {
    const provider=providerCatalog.find(item=>item.id===providerId) || backendInfo?.providers?.find(item=>item.id===providerId);
    setSelectedProvider(providerId);
    localStorage.setItem(PROVIDER_KEY,providerId);
    setSelectedModel(provider?.default_model || "");
    setModelOptions([]);
    await loadProviderModels(providerId,base,provider?.default_model || "");
  }

  async function connectBackend(base=apiBase) {
    setBackendState("checking");
    setBackendError("");
    try {
      const response=await fetch(apiUrl("/api/config", base), { signal:AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error();
      const config=await response.json();
      setBackendInfo(config);
      setEmbeddingState(current=>current.profiles?.length?current:{...current,profiles:config.memory?.embedding_profiles||[],profile_id:config.memory?.embedding_profiles?.find(item=>item.available&&item.id!=="lexical")?.id||"lexical"});
      setAutoMaxSteps(current=>Math.min(current||24,config.auto_run?.max_steps||24));
      setRoutingMode(current=>{
        const modes=config.model_routing?.modes || ["fallback"];
        const next=modes.includes(current) ? current : config.model_routing?.mode || modes[0];
        localStorage.setItem(ROUTING_KEY,next);
        return next;
      });
      if(config.model_routing?.route_schedule?.length&&!routingRoutes.length){
        setRoutingRoutes(config.model_routing.route_schedule);
        localStorage.setItem(ROUTES_KEY,JSON.stringify(config.model_routing.route_schedule));
      }
      let discovered=config.providers || [];
      try {
        const providersResponse=await fetch(apiUrl("/api/providers",base),{signal:AbortSignal.timeout(6500)});
        if(providersResponse.ok) discovered=(await providersResponse.json()).providers || discovered;
      } catch { /* Static provider configuration remains usable when a probe times out. */ }
      setProviderCatalog(discovered);
      const preferred=selectedProvider || localStorage.getItem(PROVIDER_KEY) || config.provider;
      const usable=item=>item.configured&&item.connected!==false;
      const chosen=discovered.find(item=>item.id===preferred&&usable(item))?.id
        || discovered.find(item=>item.id===config.provider&&usable(item))?.id
        || discovered.find(usable)?.id
        || discovered.find(item=>item.id===preferred&&item.configured)?.id
        || discovered.find(item=>item.configured)?.id
        || config.provider;
      const provider=discovered.find(item=>item.id===chosen);
      const primaryModel=chosen===preferred&&selectedModel ? selectedModel : provider?.default_model||config.model||"";
      setSelectedProvider(chosen);
      localStorage.setItem(PROVIDER_KEY,chosen);
      setSelectedModel(primaryModel);
      setRoutingRoutes(current=>{
        if(current.length>1)return [{provider:chosen,model:primaryModel},...current.slice(1)].slice(0,4);
        const chain=initialSession.agent?.fallbackProviders?.length
          ? initialSession.agent.fallbackProviders
          : config.model_routing?.fallback_chain||[];
        const fallbacks=chain.filter(id=>id!==chosen).flatMap(id=>{const item=discovered.find(candidate=>candidate.id===id&&candidate.configured&&candidate.connected!==false);return item?.default_model?[{provider:id,model:item.default_model}]:[];});
        const routes=[{provider:chosen,model:primaryModel},...fallbacks].slice(0,4);
        localStorage.setItem(ROUTES_KEY,JSON.stringify(routes));
        return routes;
      });
      if (config.profiles?.length) setProfile(current => {
        const next = config.profiles.includes(current) ? current : config.profiles[0];
        localStorage.setItem("hyper_profile", next);
        return next;
      });
      setBackendState("online");
      const [serverSessions]=await Promise.all([
        refreshServerSessions(base),
        loadProviderModels(chosen,base,provider?.default_model || config.model || ""),
      ]);
      const activeId=activeSessionId||initialSession.id;
      const active=serverSessions.find(item=>item.id===activeId||item.backendSessionId===initialSession.backendSessionId);
      if(active)await openSession(active,{backendOnline:true,base});
    } catch (error) {
      setBackendInfo(null);
      setBackendError(error instanceof Error && error.message ? error.message : "Runtime is not reachable");
      setBackendState("offline");
    }
  }

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current=true;
    void connectBackend();
  });

  useEffect(()=>{
    setRoutingRoutes(current=>{
      const count=ROUTE_COUNTS[routingMode]||1;
      const next=Array.from({length:count},(_,index)=>index===0
        ? {provider:selectedProvider,model:selectedModel}
        : current[index]||{provider:"",model:""});
      localStorage.setItem(ROUTES_KEY,JSON.stringify(next));
      return next;
    });
  },[selectedProvider,selectedModel,routingMode]);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSessionId(initialSession.id);
      localStorage.setItem("hyper_active_chat", initialSession.id);
    }
  }, [activeSessionId, initialSession.id]);

  useEffect(() => {
    setSessions(items=>items.map(item=>item.id===activeSessionId ? {
      ...item,
      title:messages.find(message=>message.role==="user")?.content.slice(0,42) || item.title || "New chat",
      backendSessionId:sessionId,
      messages,
      runs:pastRuns,
      updatedAt:Date.now(),
    } : item));
  }, [activeSessionId, messages, pastRuns, sessionId]);

  useEffect(() => {
    const result=persistChatSessions(localStorage,sessions);
    setStorageWarning(result.persisted
      ? result.recoveredFromQuota ? "Browser cache repaired · full history remains in the runtime" : ""
      : "Browser storage is full · this chat remains available until reload");
  }, [sessions]);

  useEffect(() => {
    if (!working) return undefined;
    setElapsed((Date.now() - run.startedAt) / 1000);
    const timer = setInterval(() => setElapsed((Date.now() - run.startedAt) / 1000), 1000);
    return () => clearInterval(timer);
  }, [working, run?.startedAt]);

  useEffect(() => {
    if (shape !== "chat" || !followTimelineRef.current || !timelineRef.current) return undefined;
    const frame=requestAnimationFrame(()=>{
      const timeline=timelineRef.current;
      if(timeline)timeline.scrollTop=timeline.scrollHeight;
    });
    return ()=>cancelAnimationFrame(frame);
  }, [messages, events.length, shape]);

  function beginRun(text, source) {
    const next = { id:id("run"), source, prompt:text, startedAt:Date.now(), status:"running", events:[] };
    activeRunIdRef.current = next.id;
    followTimelineRef.current = true;
    setMessages(items => [...items, { id:id("msg"), role:"user", content:text, runId:next.id, at:next.startedAt }]);
    setRun(next); setElapsed(0); setSelectedEventId(null); setShape("chat"); setTab("action");
    return next;
  }

  async function refreshServerSessions(base=apiBase) {
    try {
      const response=await fetch(apiUrl("/api/sessions", base));
      if (!response.ok) return [];
      const data=await response.json();
      const summaries=(data.sessions||[]).map(server=>({
        id:server.id,backendSessionId:server.id,title:server.title,agent:server.agent,
        messages:[],runs:[],updatedAt:Date.parse(server.updatedAt),
      }));
      setSessions(current=>{
        const serverSessions=summaries.map(server=>{
          const existing=current.find(item=>item.backendSessionId===server.id||item.id===server.id);
          return existing ? { ...existing, ...server, messages:existing.messages||[], runs:existing.runs||[] } : server;
        });
        const deviceOnly=current.filter(item=>!item.backendSessionId&&!serverSessions.some(server=>server.id===item.id));
        return [...serverSessions,...deviceOnly];
      });
      return summaries;
    } catch {
      // Device-local sessions remain available while the runtime is offline.
      return [];
    }
  }

  async function openSession(next,options={}) {
    if (working) return;
    setActiveSessionId(next.id);
    localStorage.setItem("hyper_active_chat", next.id);
    setMessages(next.messages?.length ? uniqueMessages(next.messages) : initialMessages());
    setPastRuns(next.runs || []);
    setSessionId(next.backendSessionId || null);
    setRun(null);
    setPendingApproval(null);
    setAttachments([]);
    setArtifacts([]);
    setLinkedFiles([]);
    if (next.agent) {
      if (next.agent.profile) { setProfile(next.agent.profile); localStorage.setItem("hyper_profile",next.agent.profile); }
      if (next.agent.provider) { setSelectedProvider(next.agent.provider); localStorage.setItem(PROVIDER_KEY,next.agent.provider); }
      if (next.agent.model) { setSelectedModel(next.agent.model); localStorage.setItem(MODEL_KEY,next.agent.model); }
      if (next.agent.routingMode) { setRoutingMode(next.agent.routingMode); localStorage.setItem(ROUTING_KEY,next.agent.routingMode); }
      if (next.agent.routingRoutes?.length || next.agent.fallbackProviders?.length) {
        const primary={provider:next.agent.provider,model:next.agent.model};
        const routes=next.agent.routingRoutes?.length>1 ? next.agent.routingRoutes : [primary,...(next.agent.fallbackProviders||[])
          .filter(id=>id!==primary.provider)
          .flatMap(id=>{const provider=providerCatalog.find(item=>item.id===id);return provider?.default_model?[{provider:id,model:provider.default_model}]:[];})].slice(0,4);
        setRoutingRoutes(routes);localStorage.setItem(ROUTES_KEY,JSON.stringify(routes));
      }
      setAgentAutonomous(Boolean(next.agent.autonomous));
      setAutoMode(Boolean(next.agent.autoMode));
      setAutoMaxSteps(next.agent.autoMaxSteps||backendInfo?.auto_run?.max_steps||24);
      setAgentInstructions(next.agent.instructions || "");
    } else {
      setAgentAutonomous(false);
      setAutoMode(false);
      setAgentInstructions("");
    }
    setShape("chat");
    const backendId=next.backendSessionId || (next.id.startsWith("session:") ? next.id : null);
    if (!backendId || backendState !== "online"&&!options.backendOnline) return;
    const requestBase=options.base??apiBase;
    try {
      const [messageResponse,runResponse,fileResponse]=await Promise.all([
        fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendId)}/messages`,requestBase)),
        fetch(apiUrl(`/api/runs?session_id=${encodeURIComponent(backendId)}`,requestBase)),
        fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendId)}/files`,requestBase)),
      ]);
      if (!messageResponse.ok || !runResponse.ok) return;
      const serverMessages=((await messageResponse.json()).messages || []).map(message=>({
        ...message,
        at:typeof message.at==="string" ? Date.parse(message.at) : message.at,
      }));
      const serverRuns=(await runResponse.json()).runs || [];
      if(fileResponse.ok){const fileData=await fileResponse.json();setAttachments(fileData.files||[]);setArtifacts(fileData.artifacts||[]);setEmbeddingState(fileData.embedding||{profile_id:"lexical",profiles:[],locked_at:null});}
      const hydrated=await Promise.all(serverRuns.slice(0,12).map(async item=>{
        try {
          const response=await fetch(apiUrl(`/api/runs/${encodeURIComponent(item.id)}/trail`,requestBase));
          const data=response.ok ? await response.json() : { events:[] };
          return { id:item.id,backendId:item.id,source:"runtime",prompt:item.objective,status:item.status,startedAt:Date.parse(item.startedAt),endedAt:item.endedAt?Date.parse(item.endedAt):undefined,trailSummary:data.summary,trailIntegrity:data.integrity,events:(data.events||[]).map(normalizeUiEvent) };
        } catch { return { id:item.id,backendId:item.id,source:"runtime",prompt:item.objective,status:item.status,startedAt:Date.parse(item.startedAt),events:[] }; }
      }));
      setMessages(serverMessages.length ? uniqueMessages(serverMessages) : initialMessages());
      setPastRuns(hydrated);
      setSessionId(backendId);
    } catch (error) {
      setBackendError(error.message || "Could not resume the server session");
    }
  }

  async function newChat() {
    let next=freshSession();
    if (backendState === "online") {
      try {
        const response=await fetch(apiUrl("/api/sessions"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"New chat"})});
        if (response.ok) {
          const server=(await response.json()).session;
          next={...next,id:server.id,backendSessionId:server.id,updatedAt:Date.parse(server.updatedAt)};
        }
      } catch { /* The new chat can remain device-local. */ }
    }
    setSessions(items=>[next,...items]);
    await openSession(next);
  }

  async function deleteChat(item) {
    if(working||!window.confirm(`Delete “${item.title}”? Uploaded files and session projections will be removed. Canonical run ledgers remain for audit.`))return;
    const backendId=item.backendSessionId||(item.id.startsWith("session:")?item.id:null);
    if(backendId&&backendState==="online"){
      const response=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendId)}`),{method:"DELETE"});
      const data=await response.json().catch(()=>({}));
      if(!response.ok){setBackendError(data.error||`session deletion returned ${response.status}`);return;}
    }
    const remaining=sessions.filter(session=>session.id!==item.id);
    const next=remaining[0]||freshSession();
    setSessions(remaining.length?remaining:[next]);
    if(item.id===activeSessionId)await openSession(next);
  }

  function canonicalMessageId(message) {
    if(message.id?.startsWith("message:run:"))return message.id;
    const source=timelineRuns.find(item=>item.id===message.runId);
    return source?.backendId?`message:${source.backendId}:user`:message.id;
  }

  async function branchForMessage(message) {
    const backendSession=sessionId;
    if(!backendSession||backendState!=="online")throw new Error("Connect the runtime before editing a committed prompt.");
    const response=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendSession)}/branches`),{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message_id:canonicalMessageId(message)}),
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`session branch returned ${response.status}`);
    const server=data.session;
    const prior=(server.messages||[]).map(item=>({...item,at:typeof item.at==="string"?Date.parse(item.at):item.at}));
    const next={id:server.id,backendSessionId:server.id,title:server.title,agent:server.agent,messages:prior,runs:[],updatedAt:Date.parse(server.updatedAt)};
    setSessions(items=>[next,...items]);
    setActiveSessionId(next.id);localStorage.setItem("hyper_active_chat",next.id);
    setSessionId(server.id);setMessages(prior);setPastRuns([]);setRun(null);setAttachments([]);setArtifacts([]);setLinkedFiles([]);
    return server.id;
  }

  async function ensureBackendSession() {
    if(sessionId)return sessionId;
    if(backendState!=="online")throw new Error("Connect the runtime before uploading files.");
    const response=await fetch(apiUrl("/api/sessions"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:messages.find(message=>message.role==="user")?.content.slice(0,60)||"New chat"})});
    if(!response.ok)throw new Error(`session creation returned ${response.status}`);
    const server=(await response.json()).session;
    setSessionId(server.id);
    setSessions(items=>items.map(item=>item.id===activeSessionId?{...item,backendSessionId:server.id}:item));
    return server.id;
  }

  async function uploadFiles(event) {
    const files=[...(event.target.files||[])].slice(0,4);
    event.target.value="";
    if(!files.length||uploading)return;
    setUploading(true);setBackendError("");
    try{
      const backendSession=await ensureBackendSession();
      const form=new FormData();files.forEach(file=>form.append("files",file));
      const response=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendSession)}/files`),{method:"POST",body:form});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||`upload returned ${response.status}`);
      setAttachments(current=>[...(data.files||[]),...current.filter(item=>!(data.files||[]).some(next=>next.id===item.id))]);
      const status=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(backendSession)}/files`)).then(value=>value.ok?value.json():null).catch(()=>null);
      if(status?.embedding)setEmbeddingState(status.embedding);
    }catch(error){setBackendError(error.message||"File upload failed");}
    finally{setUploading(false);}
  }

  async function deleteAttachment(fileId) {
    if(!sessionId||working)return;
    const response=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`),{method:"DELETE"});
    if(response.ok)setAttachments(items=>items.filter(item=>item.id!==fileId));
    else setBackendError("Could not remove the uploaded file.");
  }

  async function saveSettings(event) {
    event.preventDefault();
    const base=new FormData(event.currentTarget).get("apiBase")?.toString().trim().replace(/\/$/, "") || "";
    const model=selectedModel.trim();
    setApiBase(base);
    localStorage.setItem(API_BASE_KEY, base);
    localStorage.setItem(MODEL_KEY, model);
    localStorage.setItem(PROVIDER_KEY, selectedProvider);
    localStorage.setItem(ROUTING_KEY, routingMode);
    const routes=activeRoutingRoutes();
    localStorage.setItem(ROUTES_KEY,JSON.stringify(routes));
    if (sessionId) {
      try {
        const response=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/agent`,base),{
          method:"PUT",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            autonomous:agentAutonomous,
            auto_mode:autoMode,
            auto_max_steps:autoMaxSteps,
            instructions:agentInstructions,
            profile,
            provider:selectedProvider,
            model,
            routing_mode:routingMode,
            fallback_providers:routes.slice(1).map(route=>route.provider),
            routing_routes:routes,
          }),
        });
        if(response.ok){
          const agent=(await response.json()).agent;
          setSessions(items=>items.map(item=>item.id===activeSessionId?{...item,agent}:item));
        }
        if(!embeddingState.locked_at){
          const embeddingResponse=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/embedding`,base),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({profile_id:embeddingState.profile_id})});
          const embeddingData=await embeddingResponse.json().catch(()=>({}));
          if(!embeddingResponse.ok)throw new Error(embeddingData.error||"Embedding profile could not be saved");
        }
      } catch { /* Runtime settings still remain device-local. */ }
    }
    setSettingsOpen(false);
    setTimeout(()=>void connectBackend(base), 0);
  }

  function ingest(event) {
    const normalized = normalizeUiEvent(event);
    setRun(previous => previous ? {
      ...previous,
      events:previous.events.some(item=>item.uiId===normalized.uiId) ? previous.events : [...previous.events, normalized],
    } : previous);
    if (event.type === "respond.final" && event.payload?.text) {
      setMessages(items => [...items, { id:id("msg"), role:"assistant", content:event.payload.text, runId:activeRunIdRef.current, at:normalized.at }]);
    }
    if (event.type === "gate.open") setPendingApproval(normalized);
    if (event.type === "gate.resolved") setPendingApproval(null);
    if (event.type === "run.end" || event.type === "run.error" || event.type === "run.pause" || event.type === "run.cancelled") {
      setRun(previous => previous ? {
        ...previous,
        status:event.type === "run.error" ? "error" : event.type === "run.pause" ? "paused" : event.type === "run.cancelled" ? "cancelled" : "complete",
        endedAt:Date.now(),
      } : previous);
    }
    return normalized;
  }

  async function sendMessage({ forceDemo=false, editMessage=null, textOverride="" }={}) {
    const text = textOverride.trim() || input.trim() || (forceDemo ? "Research the best interface patterns for transparent long-running agents and recommend an implementation." : "");
    if (!text || working) return;
    let targetSessionId=sessionId;
    const branchMessage=editMessage||editingMessage;
    if(branchMessage){
      try{targetSessionId=await branchForMessage(branchMessage);setEditingMessage(null);}
      catch(error){setBackendError(error.message||"Could not branch this prompt");return;}
    }
    setInput("");
    const started = beginRun(text, forceDemo ? "guided demo" : "runtime");
    abortRef.current = new AbortController();
    try {
      if (forceDemo) throw new Error("guided-demo");
      const response = await fetch(apiUrl("/api/chat"), {
        method:"POST", signal:abortRef.current.signal, headers:{ "content-type":"application/json" },
        body:JSON.stringify({
          message:text,
          session_id:targetSessionId,
          profile,
          provider:selectedProvider || backendInfo?.provider,
          model:selectedModel || backendInfo?.model,
          routing_mode:routingMode,
          fallback_providers:activeRoutingRoutes().slice(1).map(route=>route.provider),
          routing_routes:activeRoutingRoutes(),
          auto_mode:autoMode,
          ...(runMode!=="auto"?{run_mode:runMode}:{}),
          ...(reasoningEffort!=="auto"?{reasoning_effort:reasoningEffort}:{}),
          linked_files:linkedFiles.map(file=>file.scope==="workspace"||file.scope==="artifact"?{scope:"workspace",path:file.path}:{scope:"session",id:file.id}),
        }),
      });
      await consumeRuntimeStream(response);
      setRun(previous => previous?.status === "running" ? { ...previous, status:"complete", endedAt:Date.now() } : previous);
      if(targetSessionId){const fileResponse=await fetch(apiUrl(`/api/sessions/${encodeURIComponent(targetSessionId)}/files`)).catch(()=>null);if(fileResponse?.ok){const data=await fileResponse.json();setAttachments(data.files||[]);setArtifacts(data.artifacts||[]);}}
    } catch (error) {
      if (error.name === "AbortError") return;
      if (forceDemo) {
        setRun(previous => previous ? { ...previous, source:"guided demo" } : previous);
        await runGuidedDemo(started, text);
      } else {
        setBackendState("offline");
        setBackendError(error.message || "Runtime connection failed");
        ingest({ type:"run.error", phase:"error", summary:error.message || "Runtime connection failed", payload:{}, run_id:started.id });
        setMessages(items=>[...items,{ id:id("msg"), role:"assistant", content:`Backend connection failed: ${error.message}. Open Settings to check the runtime URL, then reconnect.`, runId:started.id, at:Date.now() }]);
      }
    }
  }

  async function consumeRuntimeStream(response) {
    if (!response.ok || !response.body) throw new Error(`runtime returned ${response.status}`);
    setBackendState("online");
    await readSse(response, frame => {
      if (frame.kind === "meta") {
        if (frame.session_id) { setSessionId(frame.session_id); localStorage.setItem("shovs_session", frame.session_id); }
        if (frame.run_id) activeBackendRunIdRef.current=frame.run_id;
        setRun(previous => previous ? {
          ...previous,
          backendId:frame.run_id,
          streamContract:{version:frame.stream_version,eventSchema:frame.event_schema_version,evidenceClass:frame.evidence_class},
          provider:frame.provider,
          model:frame.model,
          profile:frame.profile,
        } : previous);
      } else if (frame.kind === "event") ingest(frame.event);
    });
  }

  async function resumeRun(source) {
    if (working || !source?.id) return;
    setOperatorPanel(null);
    beginRun(`Resume ${source.objective || source.prompt || source.id}`, "checkpoint continuation");
    abortRef.current = new AbortController();
    try {
      const response=await fetch(apiUrl(`/api/runs/${encodeURIComponent(source.id)}/resume`),{method:"POST",signal:abortRef.current.signal});
      await consumeRuntimeStream(response);
      setRun(previous=>previous?.status==="running"?{...previous,status:"complete",endedAt:Date.now()}:previous);
    } catch(error) {
      if(error.name==="AbortError")return;
      ingest({type:"run.error",phase:"error",title:"Checkpoint continuation failed",detail:error.message||"Runtime connection failed",payload:{}});
    }
  }

  async function resolveApproval(approved) {
    if (!pendingApproval || !run?.backendId) return;
    try {
      const response=await fetch(apiUrl(`/api/runs/${encodeURIComponent(run.backendId)}/approval`), {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({ approved }),
      });
      if (!response.ok) throw new Error(`approval returned ${response.status}`);
      setPendingApproval(null);
    } catch (error) {
      setBackendError(error.message || "Approval response failed");
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
      await emit(900,"receipt.commit","commit","Committed the guided run receipt",{ policy:"demo receipt only", durable_agent_memory:false });
      await emit(800,"run.end","done","Completed guided agent run",{ status:"completed",duration_ms:Date.now()-started.startedAt,usage:{input_tokens:1840,output_tokens:226} });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }

  async function stopRun() {
    demoToken.current += 1;
    const backendRunId=activeBackendRunIdRef.current||run?.backendId;
    setRun(previous => previous ? { ...previous, status:"cancelling" } : previous);
    let durableCancellation=false;
    if(backendRunId&&backendState==="online"){
      try{
        const response=await fetch(apiUrl(`/api/runs/${encodeURIComponent(backendRunId)}/cancel`),{method:"POST"});
        const data=await response.json().catch(()=>({}));
        if(!response.ok&&data.status){setRun(previous=>previous?{...previous,status:data.status,endedAt:Date.now()}:previous);return;}
        durableCancellation=response.ok;
      } catch {/* The stream can still be stopped locally, but not called durably cancelled. */}
    }
    if(!durableCancellation){
      abortRef.current?.abort();
      setRun(previous => previous ? { ...previous, status:"interrupted", endedAt:Date.now() } : previous);
    }
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
      <div className="mcm-workspace">
      <aside className="mcm-session-rail">
        <div className="mcm-session-head"><div><small>Workspace</small><strong>Chats</strong></div><button onClick={newChat} disabled={working} title="New chat"><Plus size={15}/></button></div>
        <button className="mcm-new-chat" onClick={newChat} disabled={working}><Plus size={14}/>New chat</button>
        <nav className="mcm-library-nav" aria-label="Operator workspace"><button onClick={()=>setOperatorPanel("files")}><FolderOpen size={12}/>Files</button><button onClick={()=>setOperatorPanel("runs")}><Layers3 size={12}/>Library</button></nav>
        <div className="mcm-session-list">{[...sessions].sort((a,b)=>b.updatedAt-a.updatedAt).map(item=><div key={item.id} className={item.id===activeSessionId?"active":""}><button onClick={()=>openSession(item)}><MessageSquare size={13}/><span><strong>{item.title}</strong><small>{item.runs?.length || item.runCount || 0} runs</small></span></button><button className="delete" onClick={()=>void deleteChat(item)} title="Delete chat" aria-label={`Delete ${item.title}`}><Trash2 size={12}/></button></div>)}</div>
        {storageWarning&&<div className="mcm-storage-warning" role="status">{storageWarning}</div>}
        <div className={`mcm-connection-card ${backendState}`}><span className={`mcm-backend-dot ${backendState}`}/><div><strong>{backendState === "online" ? "Backend connected" : backendState === "checking" ? "Connecting…" : "Backend offline"}</strong><small>{backendState === "online" ? `${selectedProvider || backendInfo?.provider} · ${selectedModel || backendInfo?.model}` : backendError || "Start with bun run dev"}</small></div><button onClick={()=>void connectBackend()} title="Reconnect"><RotateCw size={13}/></button></div>
      </aside>
      <section className={`mcm-shell shape-${shape} ${working ? "is-working" : "is-idle"}`} style={{ "--mcm-phase":PHASE_COLOR[currentView.phase] || PHASE_COLOR.model }}>
        <div className="mcm-shape-code" aria-hidden="true"><span>[~]</span><ChevronRight size={12}/><span className={working ? "active":""}>[{`{~}`} ]</span><ChevronRight size={12}/><span className={shape === "inspect" ? "active":""}>{`{[…]}`}</span></div>

        {settingsOpen&&<div className="mcm-settings-overlay" role="dialog" aria-modal="true" aria-label="Runtime settings"><form className="mcm-settings" onSubmit={saveSettings}>
          <header><div><Server size={17}/><span><strong>Runtime settings</strong><small>Live models, pass routing, and authority</small></span></div><button type="button" onClick={()=>setSettingsOpen(false)}><X size={15}/></button></header>
          <label>Backend URL<input name="apiBase" defaultValue={apiBase} placeholder="Same origin (/api proxy)"/><small>Leave empty when using bun run dev.</small></label>
          <label>Route A provider<select value={selectedProvider} onChange={event=>void chooseProvider(event.target.value)}>{providerCatalog.map(item=><option key={item.id} value={item.id} disabled={!item.configured}>{item.label||item.id} · {!item.configured?"not configured":item.connected===false?"offline":"ready"}</option>)}</select><small>Credentials stay in the backend.</small></label>
          <label>Route A model<select value={modelOptions.some(item=>item.id===selectedModel)?selectedModel:"__custom__"} onChange={event=>setSelectedModel(event.target.value==="__custom__"?"":event.target.value)} disabled={modelsState==="loading"}><option value="__custom__">{modelsState==="loading"?"Discovering models…":"Custom model ID…"}</option>{modelOptions.map(item=><option value={item.id} key={item.id}>{item.name||item.id}{item.context_window?` · ${Math.round(item.context_window/1024)}k ctx`:" · context unknown"}{item.quantization?` · ${item.quantization}`:""}</option>)}</select>{!modelOptions.some(item=>item.id===selectedModel)&&<input value={selectedModel} onChange={event=>setSelectedModel(event.target.value)} placeholder="Model ID"/>}<small className={modelsState==="error"?"error":""}>{modelsError||`${modelOptions.length} live models discovered`}</small></label>
          <label>Pass routing<select value={routingMode} onChange={event=>chooseRoutingMode(event.target.value)}>{(backendInfo?.model_routing?.modes||["fallback"]).map(value=><option value={value} key={value}>{ROUTING_LABEL[value]||value}</option>)}</select><small>Each scheduled route automatically falls through the remaining routes on failure.</small></label>
          {activeRouteCount()>1&&<section className="mcm-route-editor"><small>Provider / model pairs</small>{routingRoutes.slice(1,activeRouteCount()).map((route,index)=><RoutingRouteField key={index+1} index={index+1} route={route} providers={providerCatalog} apiBase={apiBase} onChange={next=>setRoutingRoutes(current=>current.map((item,itemIndex)=>itemIndex===index+1?next:item))} onRemove={routingMode==="fallback"?()=>setRoutingRoutes(current=>current.filter((_,itemIndex)=>itemIndex!==index+1)):undefined}/>)}</section>}
          {routingMode==="fallback"&&routingRoutes.length<4&&<button type="button" onClick={()=>setRoutingRoutes(current=>{const used=new Set([selectedProvider,...current.map(route=>route.provider)]);const provider=providerCatalog.find(item=>item.configured&&item.connected!==false&&!used.has(item.id));return provider?[{provider:selectedProvider,model:selectedModel},...current.slice(1),{provider:provider.id,model:provider.default_model||""}]:current;})}>Add fallback route</button>}
          <label>Capability scope<select value={profile} onChange={event=>{const next=event.target.value;setProfile(next);if(next==="partner")setAgentAutonomous(true);localStorage.setItem("hyper_profile",next);}}>{(backendInfo?.profiles||["inspect"]).map(value=><option value={value} key={value}>{backendInfo?.profile_details?.[value]?.label||value}</option>)}</select><small>{profile==="partner"?"Uses all configured tools, session memory, strict approvals, and verified completion.":"Only tools in this scope can be proposed."}</small></label>
          <label>Task depth<select value={runMode} onChange={event=>{setRunMode(event.target.value);localStorage.setItem(RUN_MODE_KEY,event.target.value);}}><option value="auto">Automatic · infer from intent</option><option value="fast">Fast</option><option value="reasoned">Reasoned</option><option value="agent">Agent</option></select><small>Automatic chooses the smallest sufficient execution loop from the requested outcome.</small></label>
          <label>Reasoning effort<select value={reasoningEffort} onChange={event=>{setReasoningEffort(event.target.value);localStorage.setItem(REASONING_KEY,event.target.value);}}><option value="auto">Automatic · model profile</option><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select><small>Only supported values are sent to the selected provider.</small></label>
          <label>Session embedding profile<select value={embeddingState.profile_id||"lexical"} disabled={Boolean(embeddingState.locked_at)} onChange={event=>setEmbeddingState(current=>({...current,profile_id:event.target.value}))}>{(embeddingState.profiles?.length?embeddingState.profiles:backendInfo?.memory?.embedding_profiles||[]).map(item=><option key={item.id} value={item.id} disabled={!item.available}>{item.label} · {item.available?"ready":"unavailable"}</option>)}</select><small>{embeddingState.locked_at?`Locked after ingestion · ${embeddingState.model||embeddingState.profile_id}. New session or reindex required to change vector space.`:"Choose once before the first upload. Retrieval queries and documents use the same pinned vector space."}</small></label>
          <details className="mcm-agent-settings"><summary>Session agent</summary><label><span><input type="checkbox" checked={agentAutonomous} onChange={event=>setAgentAutonomous(event.target.checked)}/> Keep as a reusable agent</span><small>This chat retains its route schedule, scope, history, and verified memory.</small></label><label><span><input type="checkbox" checked={autoMode} onChange={event=>setAutoMode(event.target.checked)}/> Bounded auto mode</span><small>Resolves reversible preferences and continues until verified, blocked, or budget-limited. It never expands authority.</small></label>{autoMode&&<label>Maximum autonomous steps<input type="number" min="1" max={backendInfo?.auto_run?.max_steps||24} value={autoMaxSteps} onChange={event=>setAutoMaxSteps(Math.max(1,Number(event.target.value)||1))}/><small>Server ceiling {backendInfo?.auto_run?.max_steps||24} steps · {Math.round((backendInfo?.auto_run?.max_wall_time_ms||600000)/60000)} minute wall-time limit.</small></label>}<label>Standing instructions<textarea rows={3} value={agentInstructions} onChange={event=>setAgentInstructions(event.target.value)} placeholder="Optional constraints for this session agent"/></label></details>
          {backendInfo&&<div className="mcm-runtime-contract"><small>Connected runtime contract</small><div>{(backendInfo.capabilities||[]).map(item=><span key={item.id}>{item.id}</span>)}</div><p>Approval at risk {backendInfo.approval_thresholds?.[profile]??"—"} · observed-state verification · route changes never change authority</p></div>}
          <footer><button type="button" onClick={()=>void connectBackend()}><RotateCw size={13}/>Probe connections</button><button className="primary" type="submit" disabled={!selectedProvider||!selectedModel||activeRoutingRoutes().length!==activeRouteCount()}>Save settings</button></footer>
        </form></div>}
        {operatorPanel==="files"?<FileExplorer apiBase={apiBase} sessionId={sessionId} linkedFiles={linkedFiles} onLink={file=>setLinkedFiles(current=>current.some(item=>(item.id||item.path)===(file.id||file.path))?current:[...current,file])} onClose={()=>setOperatorPanel(null)}/>:operatorPanel&&<OperatorPanel panel={operatorPanel} onPanelChange={setOperatorPanel} apiBase={apiBase} sessionId={sessionId} sessionAgentEnabled={agentAutonomous} profiles={backendInfo?.profiles||["inspect"]} providers={providerCatalog} selectedProvider={selectedProvider} selectedModel={selectedModel} modelOptions={modelOptions} allowedHosts={backendInfo?.capabilities?.find(item=>item.id==="network.http.get")?.targetPatterns||[]} onResume={resumeRun} onClose={()=>setOperatorPanel(null)}/>}

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
              <div className="mcm-title"><h2>Private operator</h2><p><span className={`mcm-backend-dot ${backendState}`}/>{backendState === "online" ? "Ready · work is verified before completion" : backendState === "checking" ? "Preparing your runtime" : "Runtime unavailable · reconnect to continue"}</p></div>
              <button className="mcm-icon-btn" onClick={newChat} title="New chat"><Plus size={15}/></button>
              <button className="mcm-icon-btn" onClick={()=>setOperatorPanel("files")} title="Browse and link files"><FolderOpen size={15}/></button>
              <button className="mcm-icon-btn" onClick={()=>setOperatorPanel("runs")} title="Operator library"><Layers3 size={15}/></button>
              <button className="mcm-icon-btn" onClick={()=>setSettingsOpen(true)} title="Runtime settings"><Settings2 size={15}/></button>
              <button className="mcm-icon-btn" onClick={()=>{setTab("history");setShape("inspect");}} title="Open turn history"><History size={15}/></button>
            </header>

            <ChatTimeline messages={messages} runs={timelineRuns} working={working} onStart={setInput} onInspect={inspectEvent} onEdit={message=>{setEditingMessage(message);setInput(message.content);}} onRegenerate={message=>void sendMessage({editMessage:message,textOverride:message.content})} timelineRef={timelineRef} onTimelineScroll={event=>{
              const node=event.currentTarget;
              followTimelineRef.current=node.scrollHeight-node.scrollTop-node.clientHeight<72;
            }}/>

            <div className="mcm-control-dock">
              {!working&&(attachments.length>0||artifacts.length>0||linkedFiles.length>0)&&<div className="mcm-attachment-strip" aria-label="Session files and generated artifacts">{linkedFiles.map(file=><span key={`link:${file.id||file.path}`} className="linked" title={`Explicitly linked from ${file.scope}`}><Link2 size={11}/><b>{file.name}</b><small>{file.scope}</small><button onClick={()=>setLinkedFiles(items=>items.filter(item=>(item.id||item.path)!==(file.id||file.path)))} aria-label={`Unlink ${file.name}`}><X size={10}/></button></span>)}{artifacts.map(file=><span key={file.id} className="artifact" title={`Verified output from ${file.runId}`}><Sparkles size={11}/><b>{file.name}</b><small>generated</small></span>)}{attachments.map(file=><span key={file.id} className={file.status==="ready"?"ready":"limited"} title={file.limitation||`${file.retrievalMode} retrieval`}><FileText size={11}/><b>{file.name}</b><small>{file.retrievalMode}</small><button onClick={()=>void deleteAttachment(file.id)} aria-label={`Remove ${file.name}`}><X size={10}/></button></span>)}</div>}
              {pendingApproval ? <div className="mcm-approval-gate"><span><CircleStop size={16}/></span><div><small>Proposal-scoped approval</small><strong>{pendingApproval.payload?.capabilityId}</strong><p>{pendingApproval.payload?.target} · risk {pendingApproval.payload?.risk} · {(pendingApproval.payload?.declaredEffects||[]).join(", ")}</p></div><button className="reject" onClick={()=>void resolveApproval(false)}>Reject</button><button className="approve" onClick={()=>void resolveApproval(true)}>Approve once</button></div> : <div className={`mcm-parent-shape ${working ? "agent":"input"}`}>
                {working ? (
                  <AgentCapsule view={currentView} elapsed={elapsed} phaseIndex={phaseIndex} events={events} tools={toolCalls.length} onOpen={()=>{setTab("action");setShape("inspect");}} onStop={stopRun}/>
                ) : (
                  <div className="mcm-input-shape">
                    <input ref={fileInputRef} type="file" multiple hidden onChange={uploadFiles}/>
                    <button className="mcm-attach" onClick={()=>fileInputRef.current?.click()} disabled={uploading||backendState!=="online"} title={backendInfo?.features?.embeddings?`Upload session files · hybrid retrieval with ${backendInfo?.memory?.embedding_model}`:"Upload session files · lexical, temporal, and relationship retrieval"}>{uploading?<Loader2 size={15}/>:<Paperclip size={15}/>}</button>
                    <button className="mcm-attach" onClick={()=>setOperatorPanel("files")} disabled={backendState!=="online"} title="Browse workspace and session files"><Folder size={15}/></button>
                    <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key === "Escape"&&editingMessage){setEditingMessage(null);setInput("");}if(e.key === "Enter" && !e.shiftKey){e.preventDefault();sendMessage();}}} placeholder={editingMessage?"Edit prompt in a new branch…":"Ask for a multi-step task…"} rows={1}/>
                    <button className="mcm-auto-badge" onClick={()=>setSettingsOpen(true)} title="Automatic task depth, provider reasoning, and bounded authority"><Sparkles size={13}/> Auto</button>
                    <button className="mcm-send" onClick={()=>sendMessage()} disabled={!input.trim()} aria-label="Send"><Send size={16}/></button>
                  </div>
                )}
              </div>}
            </div>
          </>
        )}
      </section>
      </div>
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
      const source=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
      if(!source)continue;
      try { onFrame(JSON.parse(source)); }
      catch { throw new Error("Runtime stream emitted an invalid event frame."); }
    }
  }
}

function FileExplorer({apiBase,sessionId,linkedFiles,onLink,onClose}) {
  const [scope,setScope]=useState("workspace"),[path,setPath]=useState("workspace/"),[items,setItems]=useState([]),[preview,setPreview]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const base=apiBase.replace(/\/$/,"");
  const linked=file=>linkedFiles.some(item=>(item.id||item.path)===(file.id||file.path));
  async function load(nextScope=scope,nextPath=path){setLoading(true);setError("");setPreview(null);try{const endpoint=nextScope==="workspace"?`${base}/api/filesystem?path=${encodeURIComponent(nextPath)}`:`${base}/api/sessions/${encodeURIComponent(sessionId)}/files`;const response=await fetch(endpoint);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`files returned ${response.status}`);setItems(nextScope==="workspace"?(data.entries||[]):[...(data.artifacts||[]).map(file=>({...file,kind:"file",scope:"artifact",recordType:"artifact"})),...(data.files||[]).map(file=>({...file,kind:"file",scope:"session",recordType:"upload"}))]);if(nextScope==="workspace")setPath(data.path||nextPath);}catch(reason){setItems([]);setError(reason.message||"Could not load files");}finally{setLoading(false);}}
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load uses this exact scope/path snapshot.
  useEffect(()=>{void load(scope,path);},[scope,path,sessionId,base]);
  async function inspect(file){if(file.kind==="directory"){setPath(file.path);return;}if(file.kind!=="file")return;setLoading(true);setError("");try{const endpoint=scope==="workspace"?`${base}/api/filesystem/preview?path=${encodeURIComponent(file.path)}`:file.recordType==="artifact"?`${base}/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(file.id)}/preview`:`${base}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}/preview`;const response=await fetch(endpoint);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`preview returned ${response.status}`);setPreview({...data,scope:data.scope||scope,path:file.path||data.path,id:file.id||data.id});}catch(reason){setError(reason.message||"Preview failed");}finally{setLoading(false);}}
  const up=path==="workspace/"?null:path.split("/").slice(0,-1).join("/")||"workspace/",contentUrl=preview?.contentUrl?`${base}${preview.contentUrl}`:"";
  return <div className="mcm-operator-overlay" role="dialog" aria-modal="true" aria-label="File explorer"><section className="mcm-file-explorer"><header><div><small>Runtime context</small><strong>Files</strong></div><nav><button className={scope==="workspace"?"active":""} onClick={()=>setScope("workspace")}>Universal workspace</button><button className={scope==="session"?"active":""} onClick={()=>setScope("session")} disabled={!sessionId}>This session</button></nav><button onClick={onClose}><X size={15}/></button></header><div className="mcm-file-path"><button disabled={!up||scope!=="workspace"} onClick={()=>up&&load("workspace",up)}><ArrowLeft size={12}/></button><span>{scope==="workspace"?path:`session://${sessionId||"not-connected"}`}</span><small>{items.length} items</small></div>{error&&<p className="mcm-panel-error">{error}</p>}<main><div className="mcm-file-list">{loading&&!items.length?<EmptyState icon={Loader2} text="Reading bounded file metadata…"/>:items.length?items.map(file=><button key={file.id||file.path} className={(preview?.id||preview?.path)===(file.id||file.path)?"active":""} disabled={file.kind==="symlink"} onClick={()=>void inspect(file)}>{file.kind==="directory"?<Folder size={15}/>:<FileText size={15}/>}<span><strong>{file.name}</strong><small>{file.kind==="directory"?"directory":`${file.previewKind||file.mediaType||"file"} · ${formatBytes(file.sizeBytes)}`}</small></span><ChevronRight size={13}/></button>):<EmptyState icon={FolderOpen} text={`No ${scope} files available.`}/>}</div><div className="mcm-file-preview">{preview?<><header><span><small>{preview.previewKind}</small><strong>{preview.name}</strong><em>{formatBytes(preview.sizeBytes)}{preview.truncated?" · bounded preview":""}</em></span><button disabled={linked(preview)} onClick={()=>onLink({scope:preview.scope,id:preview.id,path:preview.path,name:preview.name,previewKind:preview.previewKind})}><Link2 size={12}/>{linked(preview)?"Linked":"Link to chat"}</button></header><FilePreview preview={preview} contentUrl={contentUrl}/></>:<EmptyState icon={Eye} text="Choose a file for a typed preview and explicit chat link."/>}</div></main></section></div>;
}

function formatBytes(value){if(!Number.isFinite(value))return "—";if(value<1024)return `${value} B`;if(value<1024*1024)return `${(value/1024).toFixed(1)} KB`;return `${(value/1024/1024).toFixed(1)} MB`;}
function FilePreview({preview,contentUrl}){if(["code","markdown","json","csv","text"].includes(preview.previewKind))return <pre className={`mcm-preview-text kind-${preview.previewKind}`}><code>{preview.content||"No text preview available."}</code></pre>;if(preview.previewKind==="image")return <div className="mcm-preview-media"><img src={contentUrl} alt={preview.name}/></div>;if(preview.previewKind==="audio")return <div className="mcm-preview-media"><audio controls src={contentUrl}/></div>;if(preview.previewKind==="video")return <div className="mcm-preview-media"><video controls src={contentUrl}/></div>;if(preview.previewKind==="pdf")return <iframe className="mcm-preview-pdf" src={contentUrl} title={preview.name}/>;return <EmptyState icon={FileText} text="Binary preview is unavailable. The file can still be linked as metadata."/>;}

function OperatorPanel({panel,onPanelChange,apiBase,sessionId,sessionAgentEnabled,profiles,providers,selectedProvider,selectedModel,modelOptions,allowedHosts,onResume,onClose}) {
  const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[selected,setSelected]=useState(null);
  const [pendingAction,setPendingAction]=useState("");
  const [scheduleProvider,setScheduleProvider]=useState(selectedProvider),[scheduleModel,setScheduleModel]=useState(selectedModel),[scheduleModels,setScheduleModels]=useState(modelOptions);
  const endpoint={runs:"/api/runs",memory:`/api/memory?session_id=${encodeURIComponent(sessionId||"session:none")}`,tools:"/api/custom_tools",schedules:"/api/schedules",scorecard:"/api/scorecard",signals:"/api/signals",corrections:"/api/corrections"}[panel];
  const endpointUrl=path=>`${apiBase.replace(/\/$/,"")}${path}`;
  const recordsFor=value=>panel==="runs"?value?.runs:panel==="memory"?value?.memory:panel==="tools"?value?.custom_tools:panel==="schedules"?value?.schedules:panel==="signals"?value?.runs:panel==="corrections"?value?.corrections:null;
  async function refresh(){setLoading(true);setError("");try{const response=await fetch(endpointUrl(endpoint));if(!response.ok)throw new Error(`runtime returned ${response.status}`);const value=await response.json();setData(value);setSelected(current=>current?(recordsFor(value)||[]).find(item=>item.id===current.id)||null:null);}catch(reason){setError(reason.message||"Could not load this view");}finally{setLoading(false);}}
  useEffect(()=>{let active=true;setLoading(true);setError("");fetch(`${apiBase.replace(/\/$/,"")}${endpoint}`).then(async response=>{if(!response.ok)throw new Error(`runtime returned ${response.status}`);const value=await response.json();if(active)setData(value);}).catch(reason=>{if(active)setError(reason.message||"Could not load this view");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[apiBase,endpoint]);
  useEffect(()=>{if(panel!=="schedules"||!scheduleProvider)return;let active=true;fetch(`${apiBase.replace(/\/$/,"")}/api/models/${encodeURIComponent(scheduleProvider)}`).then(async response=>{const value=await response.json().catch(()=>({}));if(!response.ok)throw new Error(value.error||`model discovery returned ${response.status}`);if(!active)return;const models=(value.models||[]).filter(item=>item?.id);setScheduleModels(models);setScheduleModel(current=>models.some(item=>item.id===current)?current:value.default_model||models[0]?.id||current);}).catch(reason=>{if(active)setError(reason.message||"Could not discover schedule models");});return()=>{active=false;};},[apiBase,panel,scheduleProvider]);
  async function mutate(path,options={}){const response=await fetch(endpointUrl(path),options);if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(value.error||`runtime returned ${response.status}`);}if(response.headers.get("content-type")?.includes("text/event-stream"))await response.text();await refresh();}
  async function runMutation(path,options={}){if(pendingAction)return;setPendingAction(path);setError("");try{await mutate(path,options);}catch(reason){setError(reason.message||"The runtime action failed");}finally{setPendingAction("");}}
  async function addTool(event){event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await mutate("/api/custom_tools",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:values.name,description:values.description,host:values.host,path_prefix:values.pathPrefix})});event.currentTarget.reset();}catch(reason){setError(reason.message);}}
  async function addSchedule(event){event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await mutate("/api/schedules",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:values.prompt,profile:values.profile,provider:scheduleProvider,model:scheduleModel,interval_minutes:Number(values.intervalMinutes),...(sessionAgentEnabled&&sessionId?{session_id:sessionId}:{})})});event.currentTarget.reset();}catch(reason){setError(reason.message);}}
  async function addCorrection(event){event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await mutate("/api/corrections",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({observed:values.observed,mismatch:values.mismatch,correction:values.correction,reusable_rule:values.reusableRule,trigger_codes:String(values.triggerCodes||"").split(",").map(value=>value.trim()).filter(Boolean)})});event.currentTarget.reset();}catch(reason){setError(reason.message);}}
  const items=recordsFor(data);
  return <div className="mcm-operator-overlay" role="dialog" aria-modal="true" aria-label={`${panel} view`}><section className="mcm-operator-panel"><header><div><small>Operator library</small><strong>{panel}</strong></div><nav>{["runs","memory","tools","schedules","signals","corrections"].map(value=><button key={value} className={value===panel?"active":""} onClick={()=>onPanelChange(value)}>{value}</button>)}</nav><button onClick={onClose}><X size={15}/></button></header>{error&&<p className="mcm-panel-error">{error}</p>}{panel==="tools"&&<form className="mcm-inline-form" onSubmit={addTool}><input name="name" placeholder="tool_name" required/><input name="description" placeholder="What this GET tool returns" required/><input name="host" list="mcm-hosts" placeholder="allowlisted host" required/><datalist id="mcm-hosts">{allowedHosts.map(value=><option key={value} value={String(value).replace(/^https?:\/\//,"").split("/")[0]}/>)}</datalist><input name="pathPrefix" placeholder="/api/" defaultValue="/"/><button>Add bounded tool</button></form>}{panel==="schedules"&&<form className="mcm-inline-form schedule" onSubmit={addSchedule}><input name="prompt" placeholder="Task to run" required/><select name="profile">{profiles.map(value=><option key={value}>{value}</option>)}</select><select aria-label="Schedule provider" value={scheduleProvider} onChange={event=>{setScheduleProvider(event.target.value);setScheduleModel("");setScheduleModels([]);}}>{providers.filter(item=>item.configured).map(item=><option key={item.id} value={item.id}>{item.label||item.id}</option>)}</select><select aria-label="Schedule model" value={scheduleModel} onChange={event=>setScheduleModel(event.target.value)}><option value="">Select model</option>{scheduleModels.map(item=><option key={item.id} value={item.id}>{item.name||item.id}</option>)}</select><input name="intervalMinutes" type="number" min="1" defaultValue="60"/><button disabled={!scheduleProvider||!scheduleModel} title={sessionAgentEnabled?"Runs inside this session agent with its isolated history and memory":"Enable this chat as a reusable agent in Settings to link its schedules"}>{sessionAgentEnabled?"Schedule agent":"Add schedule"}</button></form>}{panel==="corrections"&&<form className="mcm-inline-form correction" onSubmit={addCorrection}><input name="observed" placeholder="Observed result" required/><input name="mismatch" placeholder="Mismatch with intent" required/><input name="correction" placeholder="Correction that worked" required/><input name="reusableRule" placeholder="Candidate reusable rule" required/><input name="triggerCodes" placeholder="Trigger codes, comma separated"/><button>Queue candidate</button></form>}<main>{loading?<EmptyState icon={Loader2} text="Loading runtime projection…"/>:panel==="scorecard"?<div className="mcm-score-grid">{Object.entries(data||{}).map(([key,value])=><Insight key={key} value={typeof value==="number"&&value>0&&value<1?`${Math.round(value*100)}%`:String(value)} label={key.replaceAll("_"," ")}/>)}</div>:<>{panel==="signals"&&<div className="mcm-score-grid compact">{Object.entries(data?.aggregate||{}).map(([key,value])=><Insight key={key} value={String(value)} label={key.replaceAll("_"," ")}/>)}</div>}<div className="mcm-record-layout"><div className="mcm-record-list">{items?.length?items.map(item=><button key={item.id} className={selected?.id===item.id?"active":""} onClick={()=>setSelected(item)}><span><strong>{item.title||item.name||item.prompt||item.content?.slice(0,70)||item.mismatch||item.id}</strong><small>{item.status||item.lastStatus||item.profile||item.host||"verified record"}</small></span><ChevronRight size={13}/></button>):<EmptyState icon={Database} text={`No ${panel} records yet.`}/>}</div><div className="mcm-record-detail">{selected?<><NaturalObject value={selected}/><div className="mcm-record-actions">{panel==="runs"&&selected.status==="interrupted"&&<button onClick={()=>onResume(selected)}>Resume from checkpoint</button>}{panel==="memory"&&<button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/memory/${encodeURIComponent(selected.id)}`,{method:"DELETE"})}>{pendingAction?"Deleting…":"Delete memory"}</button>}{panel==="tools"&&<><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/custom_tools/${encodeURIComponent(selected.id)}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!selected.enabled})})}>{selected.enabled?"Disable":"Enable"}</button><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/custom_tools/${encodeURIComponent(selected.id)}`,{method:"DELETE"})}>Delete</button></>}{panel==="schedules"&&<><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/schedules/${encodeURIComponent(selected.id)}/run`,{method:"POST"})}>Run now</button><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/schedules/${encodeURIComponent(selected.id)}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!selected.enabled})})}>{selected.enabled?"Pause":"Enable"}</button><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/schedules/${encodeURIComponent(selected.id)}`,{method:"DELETE"})}>Delete</button></>}{panel==="corrections"&&selected.status==="candidate"&&<><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/corrections/${encodeURIComponent(selected.id)}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({status:"accepted_for_experiment"})})}>Accept for experiment</button><button disabled={!!pendingAction} onClick={()=>void runMutation(`/api/corrections/${encodeURIComponent(selected.id)}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({status:"rejected"})})}>Reject</button></>}</div></>:<EmptyState icon={Search} text="Select a record to inspect its provenance and state."/>}</div></div></>}</main></section></div>;
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

const OPERATOR_STARTERS = [
  ['Decide with evidence', 'Research this decision, compare the strongest options, and recommend one with evidence and risks.'],
  ['Build or fix', 'Inspect the project, identify the highest-impact gap, implement the fix, and verify it.'],
  ['Create a deliverable', 'Turn my goal and attached context into a polished, usable deliverable.'],
];

function ChatTimeline({ messages, runs, working, onStart, onInspect, onEdit, onRegenerate, timelineRef, onTimelineScroll }) {
  const ungrouped=messages.filter(message=>!message.runId);
  return <div className="mcm-chat-timeline" ref={timelineRef} onScroll={onTimelineScroll}>
    {ungrouped.map(message=><div key={message.id} className={`mcm-bubble ${message.role}`}>{message.content}</div>)}
    {!working&&runs.length===0&&<section className="mcm-starting-points"><small>Start with an outcome</small><div>{OPERATOR_STARTERS.map(([label,prompt])=><button key={label} onClick={()=>onStart(prompt)}><span>{label}</span><ChevronRight size={14}/></button>)}</div><p>Hyper selects task depth and tools automatically. Files, evidence, and the full runtime trail stay inspectable.</p></section>}
    {runs.map((item,index)=>{
      const runMessages=messages.filter(message=>message.runId===item.id), visibleEvents=item.events.filter(event=>!["model.delta","respond.final"].includes(event.type)).map(normalizeUiEvent);
      const active=working&&index===runs.length-1;
      return <React.Fragment key={item.id}>{runMessages.filter(message=>message.role==="user").map(message=><div key={message.id} className="mcm-message-wrap user"><div className="mcm-bubble user">{message.content}</div>{!active&&<div className="mcm-message-actions"><button onClick={()=>onEdit(message)} title="Edit in a new branch"><Pencil size={11}/>Edit</button><button onClick={()=>onRegenerate(message)} title="Regenerate from this prompt"><RotateCw size={11}/>Retry</button></div>}</div>)}{visibleEvents.length>0&&<RunWorkflowCard run={item} events={visibleEvents} active={active} onInspect={event=>onInspect(event,item)}/>} {runMessages.filter(message=>message.role==="assistant").map(message=><div key={message.id} className="mcm-bubble assistant">{message.content}</div>)}</React.Fragment>;
    })}
  </div>;
}

function RunWorkflowCard({run,events,active,onInspect}) {
  const [expanded,setExpanded]=useState(false);
  const failures=events.filter(event=>["error","blocked"].includes(event.state)).length;
  const verified=events.filter(event=>(event.lens==="verification"||event.type==="verify.verdict")&&event.state==="success").length;
  const evidence=new Set(events.flatMap(event=>event.correlation?.evidence_refs||[])).size;
  const canonical=events.some(event=>event.canonical_event_id);
  const conversational=events.some(event=>event.payload?.responseLane==="conversation");
  const highlighted=events.filter(event=>["error","blocked"].includes(event.state));
  const compact=[events[0],...highlighted.slice(-1),...events.slice(-3)].filter(Boolean);
  const visible=expanded?events:[...new Map(compact.map(event=>[event.uiId,event])).values()];
  const completed=run.status==="complete"||run.status==="completed";
  const status=active?"running":failures?"attention":completed?(conversational?"answered":verified||evidence?"verified":"completed"):run.status||"finished";
  return <section className={`mcm-workflow-stack ${active?"active":""}`}>
    <button className="mcm-workflow-summary" onClick={()=>setExpanded(value=>!value)} aria-expanded={expanded}>
      <span className={`mcm-run-signal ${status}`}><i/>{status}</span>
      <span className="mcm-workflow-heading"><strong>{active?"Agent is working":conversational?"Direct response":"Agent workflow"}</strong><small>{conversational?"one model response · no tools":`${run.source||"runtime"} · ${events.length} ${canonical?"canonical projections":"runtime events"}`}</small></span>
      <span className="mcm-workflow-proof"><b>{verified}</b><small>verified</small></span>
      <span className="mcm-workflow-proof"><b>{evidence}</b><small>evidence</small></span>
      {expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button>
    {expanded&&run.trailIntegrity?.valid&&<div className="mcm-integrity-strip"><Check size={11}/> ledger integrity verified <span>· {shortHash(run.trailIntegrity.latest_hash)}</span></div>}
    <div className="mcm-workflow-events">{visible.map(event=><WorkflowRow key={event.uiId} event={event} active={active&&event===events.at(-1)} onClick={()=>onInspect(event)}/>)}</div>
    {!expanded&&events.length>visible.length&&<button className="mcm-show-trace" onClick={()=>setExpanded(true)}>Show {events.length-visible.length} more events</button>}
  </section>;
}

function WorkflowRow({event,active,onClick}) {
  const view=viewOf(event), Icon=view.Icon;
  return <button className={`mcm-workflow-row ${active ? "active":""} state-${event.state||"info"}`} onClick={onClick} style={{"--event-color":PHASE_COLOR[view.phase]}}>
    <span className="mcm-event-glyph"><Icon size={12}/></span><span className="mcm-event-copy"><strong>{view.title}</strong><small>{view.detail}</small></span><span className="mcm-event-time">{event.timing_source==="replay_projection"?`#${event.canonical_sequence}`:stampFrom(event.at)}</span><ChevronRight size={13}/>
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
  const Icon=view.Icon, verified=events.filter(e=>(e.lens==="verification"||e.type==="verify.verdict")&&e.state==="success").length;
  const evidence=new Set(events.flatMap(event=>event.correlation?.evidence_refs||[])).size;
  const issues=events.filter(event=>["error","blocked"].includes(event.state)).length;
  const plan=[...events].reverse().find(e=>e.payload?.steps)?.payload?.steps || [];
  return <div className="mcm-action-panel"><div className="mcm-action-hero"><span className="mcm-action-orb"><BlobAvatar state={run?.status==="running"?"running":"idle"} size={56}/></span><div><small>{PHASE_LABEL[view.phase]||view.phase} · {run?.status}</small><h2><Icon size={19}/>{view.title}</h2><p>{view.detail}</p></div></div><div className="mcm-insight-grid"><Insight value={`${elapsed.toFixed(1)}s`} label="elapsed"/><Insight value={verified} label="verified transitions"/><Insight value={evidence} label="evidence refs"/><Insight value={issues} label="needs attention"/></div>{run?.streamContract&&<div className="mcm-contract-note"><Check size={12}/><span>Runtime stream {run.streamContract.version} · event schema {run.streamContract.eventSchema}</span></div>}{plan.length>0&&<PlanView steps={plan}/>}<div className="mcm-action-feed">{events.slice(-5).reverse().map(event=><WorkflowRow key={event.uiId} event={event}/>)}</div></div>;
}

function EventDetail({event}) {
  const view=viewOf(event), Icon=view.Icon, lens=eventLens(event);
  return <article className="mcm-event-detail"><header style={{"--event-color":PHASE_COLOR[view.phase]}}><span><Icon size={17}/></span><div><small>{event.type} · {lens}</small><h3>{view.title}</h3><p>{view.detail}</p></div></header>{event.canonical_event_id&&<div className="mcm-provenance-strip"><span>canonical #{event.canonical_sequence}</span><span>{event.canonical_type}</span><span className={`state-${event.state||"info"}`}>{event.state||"recorded"}</span><code>{shortHash(event.canonical_event_id)}</code></div>}<PayloadAdapter payload={event.payload||{}} event={event}/></article>;
}

function eventLens(event={}) {
  if(event.lens)return event.lens;
  if(event.type?.startsWith("model.")) return "proposal";
  if(event.type?.startsWith("policy.")||event.type?.startsWith("gate.")||event.type?.startsWith("capability.grant")||event.type?.startsWith("workflow.node")) return "runtime decision";
  if(event.type?.startsWith("tool.")) return "bounded effect";
  if(event.type?.startsWith("state.")||event.type?.startsWith("verify.")||event.type?.startsWith("action.verified")||event.type?.startsWith("effect.")) return "observed reality";
  if(event.payload?.fault||event.payload?.injected) return "injected condition";
  return "canonical event";
}

function PayloadAdapter({payload,event}) {
  const [raw,setRaw]=useState(false);
  const content=raw?<pre className="mcm-json-raw">{JSON.stringify(payload,null,2)}</pre>:adaptPayload(payload,event);
  return <div className="mcm-payload"><div className="mcm-payload-bar"><span>Visual interpretation</span><button onClick={()=>setRaw(value=>!value)}><Braces size={12}/>{raw?"insight view":"raw JSON"}</button></div>{content}</div>;
}
function adaptPayload(payload,event) {
  if(Array.isArray(payload.steps)) return <PlanView steps={payload.steps}/>;
  if(Array.isArray(payload.results)||payload.result_count!=null) return <SearchResultsView payload={payload}/>;
  if(event.lens==="verification"||payload.checks||payload.verdict||payload.passed!=null) return <VerificationView payload={payload}/>;
  if(payload.arguments||event.type==="tool.call") return <ToolRequestView payload={payload}/>;
  if(Array.isArray(payload.patterns)) return <PatternView payload={payload}/>;
  if(event.lens==="context"||payload.sources||payload.items_included!=null||payload.includedSourceIds) return <ContextView payload={payload}/>;
  return <NaturalObject value={payload}/>;
}

function PlanView({steps=[]}) { return <div className="mcm-plan-view"><h4><ListChecks size={14}/>Execution plan</h4>{steps.map((step,index)=><div key={step.id||index} className={`mcm-plan-step ${step.status||"pending"}`}><span>{step.status==="done"?<Check size={12}/>:index+1}</span><p>{step.text||step.title||String(step)}</p><small>{step.status||"pending"}</small></div>)}</div>; }
function SearchResultsView({payload}) { const results=payload.results||[]; return <div><div className="mcm-adapter-summary"><Insight value={payload.result_count??results.length} label="sources found"/><Insight value={payload.duration_ms?`${payload.duration_ms}ms`:"—"} label="retrieval time"/><Insight value={payload.domains?.length||new Set(results.map(r=>r.domain)).size} label="domains"/></div><div className="mcm-source-list">{results.map((result,index)=><div key={index}><span>{index+1}</span><div><strong>{result.title||result.name||"Source"}</strong><small>{result.domain||result.url}</small></div>{result.relevance!=null&&<b>{Math.round(result.relevance*100)}%</b>}</div>)}</div>{payload.insight&&<blockquote>{payload.insight}</blockquote>}</div>; }
function VerificationView({payload}) { const passed=payload.passed??payload.verdict!=="reject"; const reasons=payload.reasonCodes||[]; return <div><div className={`mcm-verdict ${passed?"accept":"reject"}`}>{passed?<Check size={16}/>:<X size={16}/>}<div><strong>{payload.verdict||(passed?"verified":"not verified")}</strong><small>{payload.confidence!=null?`${Math.round(payload.confidence*100)}% confidence`:reasons.length?reasons.map(value=>String(value).replaceAll("_"," ").toLowerCase()).join(" · "):"deterministic checks complete"}</small></div></div><div className="mcm-check-grid">{Object.entries(payload.checks||{}).map(([key,value])=><div key={key} className={value?"pass":"fail"}>{value?<Check size={12}/>:<X size={12}/>}<span>{key.replaceAll("_"," ")}</span></div>)}</div>{payload.evidence?.length>0&&<div className="mcm-evidence-list">{payload.evidence.map((item,index)=><span key={item.id||index}>{item.id||String(item)}</span>)}</div>}</div>; }
function ToolRequestView({payload}) { return <div><div className="mcm-tool-signature"><TerminalSquare size={16}/><div><small>tool request</small><strong>{payload.name||payload.tool||"tool"}</strong></div></div><NaturalObject value={payload.arguments||payload}/></div>; }
function PatternView({payload}) { return <div className="mcm-patterns">{payload.patterns.map((pattern,index)=>{const item=typeof pattern==="string"?{name:pattern}:pattern;return <div key={index}><span>{item.name}</span>{item.score!=null&&<i><b style={{width:`${item.score*100}%`}}/></i>}<strong>{item.score!=null?`${Math.round(item.score*100)}%`:""}</strong></div>})}{payload.insight&&<blockquote>{payload.insight}</blockquote>}</div>; }
function ContextView({payload}) { const sources=payload.sources||{}, included=payload.items_included??payload.includedSourceIds?.length??payload.items?.length??"?", total=payload.items_total??payload.audit?.sourcesConsidered??"?"; return <div><div className="mcm-adapter-summary"><Insight value={`${included}/${total}`} label="context items"/><Insight value={payload.audit?.contradictionCount??payload.contradictions??0} label="open conflicts"/><Insight value={payload.estimatedTokens??payload.chars??"—"} label={payload.estimatedTokens!=null?"estimated tokens":"characters"}/><Insight value={payload.dropped?.length||payload.excludedSourceIds?.length||0} label="items dropped"/></div><div className="mcm-context-bars">{Object.entries(sources).map(([name,value])=><div key={name}><span>{name}</span><i><b style={{width:`${Math.min(100,Number(value)*22)}%`}}/></i><strong>{String(value)}</strong></div>)}</div>{payload.includedSourceIds?.length>0&&<div className="mcm-evidence-list">{payload.includedSourceIds.map(value=><span key={value}>{value}</span>)}</div>}{payload.audit?.unresolvedConflictIds?.length>0&&<blockquote>Unresolved: {payload.audit.unresolvedConflictIds.join(" · ")}</blockquote>}</div>; }

function NaturalObject({value,depth=0}) {
  if(value==null) return <span className="mcm-scalar null">null</span>;
  if(typeof value!=="object") return <span className={`mcm-scalar ${typeof value}`}>{String(value)}</span>;
  if(Array.isArray(value)) return <div className="mcm-natural-list">{value.map((item,index)=><div key={index}><span>{index+1}</span><NaturalObject value={item} depth={depth+1}/></div>)}</div>;
  return <dl className={`mcm-natural-object depth-${Math.min(depth,2)}`}>{Object.entries(value).map(([key,item])=><div key={key}><dt>{key.replaceAll("_"," ")}</dt><dd><NaturalObject value={item} depth={depth+1}/></dd></div>)}</dl>;
}
function Insight({value,label}) { return <div className="mcm-insight"><strong>{value}</strong><span>{label}</span></div>; }
function EmptyState({icon:Icon,text}) { return <div className="mcm-empty"><Icon size={22}/><p>{text}</p></div>; }
function stampFrom(value) { if(!value)return ""; return new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function shortHash(value) { const text=String(value||""); return text.length>16?`${text.slice(0,8)}…${text.slice(-6)}`:text; }

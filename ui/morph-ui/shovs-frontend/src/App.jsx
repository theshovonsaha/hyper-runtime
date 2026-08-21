import React, { useState } from 'react';
import { ShovsProvider, useShovs } from './store/ShovsContext';
import { GooeyBackground } from './components/GooeyBackground';
import { TimelinePane } from './components/TimelinePane';
import { GateDrawer } from './components/GateDrawer';
import { ToolDetailPane } from './components/ToolDetailPane';
import { TurnDetailPane } from './components/TurnDetailPane';
import { MorphChatModal } from './demos/MorphChatModal';
import { BlobPlayground } from './demos/BlobPlayground';
import { RuntimeLab } from './demos/RuntimeLab';
import { MemoryGraph } from './demos/MemoryGraph';
import { ContextInspector } from './demos/ContextInspector';
import { BlobAvatar, MorphPanel, useViewStack } from 'morph-ui/react';
import { Send, ChevronRight, Layers, MessageSquare, Terminal, FlaskConical, BrainCircuit, Braces, SlidersHorizontal } from 'lucide-react';

function Header({ activeApp, setActiveApp }) {
  const { newSession, provider, currentModel, profile, setProfile, profiles } = useShovs();
  const [systemOpen, setSystemOpen] = useState(false);
  const systemViews = [
    ['shovs-runtime', 'Runtime trail', Terminal],
    ['runtime-lab', 'Evaluation lab', FlaskConical],
    ['memory-graph', 'Memory graph', BrainCircuit],
    ['context-inspector', 'Context inspector', Braces],
    ['blob-playground', 'Visual system', Layers],
  ];
  
  return (
    <header className="header">
      <BlobAvatar state="idle" size={28} />
      <span className="header-logo">Hyper</span>
      <span className="header-sub">private operator</span>

      <span className="header-spacer"></span>

      {activeApp !== 'chat-modal' && <button className="header-pill" onClick={() => setActiveApp('chat-modal')}><MessageSquare size={13}/> Return to operator</button>}
      <div className="header-system-menu">
        <button className={`header-pill ${activeApp !== 'chat-modal' ? 'on' : ''}`} onClick={() => setSystemOpen(value => !value)} aria-expanded={systemOpen}>
          <SlidersHorizontal size={13}/> Inspect system
        </button>
        {systemOpen && <div className="header-system-popover">
          <small>Expert surfaces</small>
          {systemViews.map(([id, label, Icon]) => <button key={id} className={activeApp === id ? 'active' : ''} onClick={() => { setActiveApp(id); setSystemOpen(false); }}><Icon size={14}/><span>{label}</span><ChevronRight size={13}/></button>)}
        </div>}
      </div>

      {activeApp === 'shovs-runtime' && (
        <>
          <span className="header-pill">
            <span className="dot" style={{ background: 'var(--c-cyan)' }}></span>
            {provider || 'model'} · {currentModel || 'default'}
          </span>

          <label className="header-pill">
            scope
            <select value={profile} onChange={event => setProfile(event.target.value)}>
              {profiles.map(value => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>

          <button className="header-pill" onClick={newSession}>＋ new</button>
        </>
      )}
    </header>
  );
}

function ChatColumn({ onViewSelect }) {
  const { messages, sendMessage, running } = useShovs();
  const [input, setInput] = useState('');
  const [isLaunching, setIsLaunching] = useState(false);

  const handleSend = async () => {
    if (!input.trim() || running) return;
    const text = input.trim();
    setInput('');
    setIsLaunching(true);

    setTimeout(async () => {
      setIsLaunching(false);
      await sendMessage(text);
    }, 400);
  };

  return (
    <section className="chat-column">
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`bubble-wrap ${m.role}`}>
            <span className="bubble-role">{m.role}</span>
            <div className={`bubble ${m.role}`}>
              {m.content}
            </div>
            {m.role === 'assistant' && m.tools && m.tools.map(tool => (
               <div 
                  key={tool.id} 
                  className="mcm-toolchip" 
                  onClick={() => onViewSelect({ type: 'tool', tool: tool })}
                  style={{ marginTop: 8 }}
               >
                 <span className={`status-dot ${tool.status}`} />
                 <span className="mono" style={{ fontSize: 11 }}>{tool.name}</span>
                 <ChevronRight size={12} style={{ marginLeft: "auto", opacity: 0.6 }} />
               </div>
            ))}
          </div>
        ))}

        {running && (
          <div className="turn-capsule running" onClick={() => onViewSelect({ type: 'turn', turn: { status: 'running', steps: [] } })}>
            <div className="turn-scan" />
            <div className="turn-avatar">
              <BlobAvatar state="running" size={24} />
            </div>
            <div className="turn-body">
              <span className="turn-ticker">processing step · running tools & inference...</span>
            </div>
            <ChevronRight size={14} className="turn-chevron" />
          </div>
        )}
      </div>
      
      <GateDrawer />
      
      <div className="composer-wrap">
        <div className={`composer ${isLaunching ? 'launching' : ''}`}>
          <textarea 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Message shovs runtime..."
          />
          <div className="composer-row">
            <span className="composer-hint">{running ? '● active turn running' : 'ready'}</span>
            <span className="spacer"></span>
            <button 
              className={`send-btn ${isLaunching ? 'sending' : ''}`}
              onClick={handleSend} 
              disabled={running || !input.trim()}
            >
              <Send size={14} />
              <span>{running ? 'Running' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrailColumn({ current, push, pop, direction }) {
  const tabs = ['timeline', 'scorecard', 'packet', 'runs', 'sessions', 'memory'];

  return (
    <section className="trail-column">
      <div className="trail-tabs">
        {tabs.map(tab => (
          <button 
            key={tab}
            className={`trail-tab ${current.type === tab ? 'active' : ''}`}
            onClick={() => push({ type: tab })}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        {current.type === 'tool' && (
          <button className="trail-tab active">Tool Detail</button>
        )}
        {current.type === 'turn' && (
          <button className="trail-tab active">Turn Detail</button>
        )}
      </div>
      
      <div className="trail-body">
        <MorphPanel viewKey={JSON.stringify(current)} direction={direction}>
          <div className="panel-view">
            {current.type === 'timeline' && <TimelinePane />}
            {current.type === 'tool' && (
              <ToolDetailPane tool={current.tool} onBack={pop} />
            )}
            {current.type === 'turn' && (
              <TurnDetailPane turn={current.turn} onOpenTool={(t) => push({ type: 'tool', tool: t })} onBack={pop} />
            )}
            {current.type !== 'timeline' && current.type !== 'tool' && current.type !== 'turn' && (
              <div style={{ color: 'var(--ink-muted)', fontSize: 12, padding: 20 }}>
                {current.type} view active
              </div>
            )}
          </div>
        </MorphPanel>
      </div>
    </section>
  );
}

function ShovsRuntime() {
  const { current, push, pop, direction } = useViewStack({ type: 'timeline' });
  return (
    <>
      <ChatColumn onViewSelect={push} />
      <TrailColumn current={current} push={push} pop={pop} direction={direction} />
    </>
  );
}

function MainLayout() {
  const [activeApp, setActiveApp] = useState('chat-modal');

  return (
    <div className="app-shell">
      <GooeyBackground />
      <Header activeApp={activeApp} setActiveApp={setActiveApp} />
      
      <main className="main-content" style={{ overflow: 'hidden' }}>
        {activeApp === 'chat-modal' && <MorphChatModal />}
        {activeApp === 'shovs-runtime' && <ShovsRuntime />}
        {activeApp === 'runtime-lab' && <RuntimeLab />}
        {activeApp === 'memory-graph' && <MemoryGraph />}
        {activeApp === 'context-inspector' && <ContextInspector />}
        {activeApp === 'blob-playground' && <BlobPlayground />}
      </main>
      
      {activeApp !== 'chat-modal' && <div className="hint-bar">
        <span className="live-dot"></span>
        <span>
          {activeApp === 'chat-modal' && 'Morph Chat Modal · compact shape-morphing assistant card'}
          {activeApp === 'shovs-runtime' && 'Transparent Runtime · live telemetry, context gate & side-by-side dashboard'}
          {activeApp === 'runtime-lab' && 'Runtime Lab · real agent comparisons, automatic findings & evidence-labelled evaluations'}
          {activeApp === 'memory-graph' && 'Runtime Graph · memory, context, tools, verification, and evidence'}
          {activeApp === 'context-inspector' && 'Context · exact model inputs, selection, tools, and detected drift'}
          {activeApp === 'blob-playground' && 'Gooey Canvas · interactive SVG shape morphing & fluid blob fusion'}
        </span>
      </div>}
    </div>
  );
}

export default function App() {
  return (
    <ShovsProvider>
      <MainLayout />
    </ShovsProvider>
  );
}

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { api } from '../api';

const ShovsContext = createContext(null);

export function ShovsProvider({ children }) {
  const [sessionId, setSessionId] = useState(localStorage.getItem('shovs_session') || null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);
  const [gateOn, setGateOn] = useState(localStorage.getItem('shovs_gate') === '1');
  const [autoOn, setAutoOn] = useState(localStorage.getItem('shovs_auto') === '1');
  const [level, setLevel] = useState(localStorage.getItem('shovs_level') || 'debug');
  const [provider, setProvider] = useState(null);
  const [providersAvailable, setProvidersAvailable] = useState({});
  const [models, setModels] = useState({});
  const [currentModel, setCurrentModel] = useState('');
  
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);

  // Fetch initial config
  useEffect(() => {
    async function boot() {
      try {
        const cfg = await api.get('/api/config');
        setProvidersAvailable(cfg.providers_available || {});
        setProvider(cfg.provider);
        setModels(cfg.models || {});
        
        // Load history if we have a session
        if (sessionId) {
          loadHistory(sessionId);
        }
      } catch (e) {
        console.error("Failed to boot config", e);
      }
    }
    boot();
  }, []);

  const loadHistory = async (sid) => {
    try {
      const data = await api.get(`/api/sessions/${sid}/messages`);
      setMessages(data.messages || []);
    } catch (e) {
      console.error("Failed to load history", e);
    }
  };

  const setGate = (val) => {
    setGateOn(val);
    localStorage.setItem('shovs_gate', val ? '1' : '0');
  };

  const setAuto = (val) => {
    setAutoOn(val);
    localStorage.setItem('shovs_auto', val ? '1' : '0');
  };

  const newSession = () => {
    setSessionId(null);
    localStorage.removeItem('shovs_session');
    setMessages([]);
    setEvents([]);
  };

  const sendMessage = async (text, files = [], images = []) => {
    if (!text || running) return;
    setRunning(true);
    
    // Optimistic UI for user message
    const tempUserMsg = { id: Date.now(), role: 'user', content: text };
    setMessages(prev => [...prev, tempUserMsg]);
    setEvents([]);
    
    try {
      const resp = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text, session_id: sessionId, provider: provider,
          model: currentModel || undefined,
          gate: gateOn, auto: autoOn, level: level, files, images,
        }),
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Stream processing
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              handleFrame(JSON.parse(line.slice(5)));
            }
          }
        }
      }
    } catch (e) {
      console.error("Chat error", e);
    } finally {
      setRunning(false);
      // Reload history to ensure we have the full clean final state
      if (sessionId) loadHistory(sessionId);
    }
  };

  const handleFrame = (frame) => {
    if (frame.kind === "meta") {
      setRunId(frame.run_id);
      if (frame.session_id && frame.session_id !== sessionId) {
        setSessionId(frame.session_id);
        localStorage.setItem("shovs_session", frame.session_id);
      }
      return;
    }
    if (frame.kind === "event") {
      setEvents(prev => [...prev, frame.event]);
      // Here we would ideally parse the event to update the currently streaming assistant message
      // In a robust implementation, we would maintain a `streamingMessage` state.
    }
  };

  return (
    <ShovsContext.Provider value={{
      sessionId, setSessionId, newSession,
      running, runId,
      gateOn, setGate,
      autoOn, setAuto,
      level, setLevel,
      provider, setProvider, providersAvailable,
      models, currentModel, setCurrentModel,
      messages, events,
      sendMessage
    }}>
      {children}
    </ShovsContext.Provider>
  );
}

export function useShovs() {
  return useContext(ShovsContext);
}

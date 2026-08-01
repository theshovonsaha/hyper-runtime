import React, { useRef, useState } from "react";
import { History, MessageSquare, ArrowLeft } from "lucide-react";
import "morph-ui/styles.css";
import { BlobAvatar, MorphPanel, useViewStack, useLaunchTransition, MorphInputDock, TurnCapsule, TurnDetailView } from "morph-ui/react";
import { MessageBubble, ToolDetailView, HistoryView } from "morph-ui/chatkit";

let uid = 0;
const nextId = () => "id" + uid++;

function makeTurn(text) {
  const toolId = nextId();
  return {
    id: nextId(),
    status: "running",
    steps: [
      {
        id: toolId,
        type: "tool_call",
        tool: {
          id: toolId,
          name: "search_knowledge_base",
          status: "running",
          query: { q: text.slice(0, 60), top_k: 3 },
          result: null,
          startedAt: new Date().toLocaleTimeString(),
          duration: null,
        },
      },
    ],
  };
}

export default function ChatDemo() {
  const [messages, setMessages] = useState([
    { id: nextId(), role: "user", type: "text", content: "How many refund requests came in last week, and what were the top reasons?" },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const { current, push, pop, reset, direction } = useViewStack({ type: "chat" });
  const { overlayRef, launch } = useLaunchTransition();

  const dockRef = useRef(null);
  const dockTargetRef = useRef(null); // invisible marker at bottom of the message list

  const allTools = messages.flatMap((m) =>
    m.type === "turn" ? m.turn.steps.filter((s) => s.type === "tool_call").map((s) => s.tool) : []
  );
  const allTurns = messages.filter((m) => m.type === "turn").map((m) => m.turn);

  const activeTurn = current.type === "turn" ? allTurns.find((t) => t.id === current.turnId) : null;
  const activeTool = current.type === "tool" ? allTools.find((t) => t.id === current.toolId) : null;

  const anyRunning = allTurns.some((t) => t.status === "running");
  const avatarState =
    current.type === "tool"
      ? activeTool?.status ?? "idle"
      : current.type === "turn"
      ? activeTurn?.status === "running"
        ? "running"
        : "success"
      : current.type === "history"
      ? "history"
      : anyRunning
      ? "running"
      : "idle";

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    await launch({ fromEl: dockRef.current, toEl: dockTargetRef.current, color: "var(--morph-accent)" });
    setSending(false);

    const turn = makeTurn(text);
    setMessages((m) => [
      ...m,
      { id: nextId(), role: "user", type: "text", content: text },
      { id: nextId(), role: "assistant", type: "turn", turn },
    ]);

    setTimeout(() => {
      setMessages((m) =>
        m.map((msg) => {
          if (msg.type !== "turn" || msg.turn.id !== turn.id) return msg;
          const steps = msg.turn.steps.map((s) =>
            s.type === "tool_call"
              ? {
                  ...s,
                  tool: {
                    ...s.tool,
                    status: "success",
                    duration: "1.4s",
                    result: { total_refunds: 42, resolved: 37, pending: 5, top_reason: "shipping_delay" },
                  },
                }
              : s
          );
          steps.push({ id: nextId(), type: "reasoning", text: "42 refunds last week, mostly shipping delays — drafting a summary." });
          return { ...msg, turn: { ...msg.turn, status: "done", steps } };
        })
      );
    }, 1700);
  }

  return (
    <div
      style={{
        width: 440,
        borderRadius: "var(--morph-radius)",
        border: "1px solid var(--morph-border)",
        background: "var(--morph-panel-bg)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div ref={overlayRef} className="morph-launch-overlay" />

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, borderBottom: "1px solid var(--morph-border)" }}>
        {current.type !== "chat" && (
          <div className="morph-pill-btn" onClick={pop}>
            <ArrowLeft size={14} />
          </div>
        )}
        <BlobAvatar state={avatarState} size={36} />
        <div style={{ flex: 1, color: "var(--morph-ink)", fontFamily: "var(--morph-font)", fontSize: 14, fontWeight: 600 }}>
          {current.type === "chat" && "Assistant"}
          {current.type === "turn" && "Turn detail"}
          {current.type === "tool" && (activeTool?.name ?? "Tool call")}
          {current.type === "history" && "Full history"}
        </div>
        {current.type === "chat" && (
          <div className="morph-pill-btn" onClick={() => push({ type: "history" })}>
            <History size={14} />
          </div>
        )}
      </div>

      <MorphPanel viewKey={JSON.stringify(current)} direction={direction}>
        {current.type === "chat" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, maxHeight: 380, overflowY: "auto" }}>
            {messages.map((m) =>
              m.type === "turn" ? (
                <TurnCapsule key={m.id} turn={m.turn} onOpen={() => push({ type: "turn", turnId: m.turn.id })} />
              ) : (
                <MessageBubble key={m.id} role={m.role}>
                  {m.content}
                </MessageBubble>
              )
            )}
            <div ref={dockTargetRef} />
          </div>
        )}
        {current.type === "turn" && activeTurn && (
          <TurnDetailView turn={activeTurn} onOpenTool={(toolId) => push({ type: "tool", toolId })} />
        )}
        {current.type === "tool" && <ToolDetailView tool={activeTool} />}
        {current.type === "history" && (
          <HistoryView
            messages={messages.map((m) =>
              m.type === "turn"
                ? { id: m.id, role: "assistant", type: "tool_call", toolCall: m.turn.steps.find((s) => s.type === "tool_call")?.tool }
                : m
            )}
            onOpenTool={(toolId) => push({ type: "tool", toolId })}
          />
        )}
      </MorphPanel>

      {current.type === "chat" && (
        <MorphInputDock ref={dockRef} value={input} onChange={setInput} onSubmit={handleSend} launching={sending} />
      )}
      {(current.type === "turn" || current.type === "tool" || current.type === "history") && (
        <div style={{ padding: 12, borderTop: "1px solid var(--morph-border)" }}>
          <div className="morph-pill-btn primary" onClick={() => reset({ type: "chat" })}>
            <MessageSquare size={13} /> Back to chat
          </div>
        </div>
      )}
    </div>
  );
}

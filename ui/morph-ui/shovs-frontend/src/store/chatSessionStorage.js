export const CHAT_SESSION_STORAGE_KEY = "hyper_chat_sessions_v1";

const CACHE_BUDGET_BYTES = 1_500_000;
const MAX_CACHED_SESSIONS = 60;
const MAX_LOCAL_MESSAGES = 24;
const MAX_MESSAGE_CHARACTERS = 6_000;

const byteLength = value => new TextEncoder().encode(value).byteLength;
const boundedText = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

function projectedAgent(agent) {
  if (!agent || typeof agent !== "object") return undefined;
  return {
    profile: boundedText(agent.profile, 64), provider: boundedText(agent.provider, 128), model: boundedText(agent.model, 256),
    routingMode: boundedText(agent.routingMode, 64),
    routingRoutes: Array.isArray(agent.routingRoutes) ? agent.routingRoutes.slice(0, 4).map(route => ({ provider: boundedText(route?.provider, 128), model: boundedText(route?.model, 256) })) : [],
    fallbackProviders: Array.isArray(agent.fallbackProviders) ? agent.fallbackProviders.slice(0, 4).map(value => boundedText(value, 128)) : [],
    autonomous: Boolean(agent.autonomous), autoMode: Boolean(agent.autoMode),
    autoMaxSteps: Number.isFinite(agent.autoMaxSteps) ? agent.autoMaxSteps : undefined,
    instructions: boundedText(agent.instructions, 8_000),
  };
}

function projectedMessage(message, characterLimit = MAX_MESSAGE_CHARACTERS) {
  return {
    id: boundedText(message?.id, 256), role: message?.role === "user" ? "user" : "assistant",
    content: boundedText(message?.content, characterLimit), runId: boundedText(message?.runId, 256) || undefined,
    at: Number.isFinite(message?.at) ? message.at : Date.now(),
  };
}

function projectedSession(session, messageLimit = MAX_LOCAL_MESSAGES, characterLimit = MAX_MESSAGE_CHARACTERS) {
  const backendSessionId = boundedText(session?.backendSessionId, 256) || null;
  const backendOwned = Boolean(backendSessionId) || boundedText(session?.id, 256).startsWith("session:");
  return {
    id: boundedText(session?.id, 256), title: boundedText(session?.title, 160) || "New chat", backendSessionId,
    agent: projectedAgent(session?.agent),
    // Backend sessions are canonical and are rehydrated from the runtime on open.
    messages: backendOwned ? [] : (Array.isArray(session?.messages) ? session.messages : []).slice(-messageLimit).map(message => projectedMessage(message, characterLimit)),
    // Run trails contain the largest payloads and are always fetched from the runtime.
    runs: [], runCount: Array.isArray(session?.runs) ? session.runs.length : Number(session?.runCount) || 0,
    updatedAt: Number.isFinite(session?.updatedAt) ? session.updatedAt : Date.now(),
  };
}

function serializeWithinBudget(sessions, budgetBytes) {
  const variants = [
    sessions.slice(0, MAX_CACHED_SESSIONS).map(session => projectedSession(session)),
    sessions.slice(0, 40).map(session => projectedSession(session, 8, 2_000)),
    sessions.slice(0, 30).map(session => projectedSession(session, 0, 0)),
  ];
  for (let index = 0; index < variants.length; index += 1) {
    const projected = variants[index];
    const serialized = JSON.stringify(projected);
    if (byteLength(serialized) <= budgetBytes) return { serialized, compacted: index > 0 };
  }
  const projected = variants.at(-1).slice(0, 10);
  return { serialized: JSON.stringify(projected), compacted: true };
}

export function loadChatSessions(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(CHAT_SESSION_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function persistChatSessions(storage, sessions, options = {}) {
  const budgetBytes = options.budgetBytes || CACHE_BUDGET_BYTES;
  const source = Array.isArray(sessions) ? sessions : [];
  const result = serializeWithinBudget(source, budgetBytes);
  try {
    storage.setItem(CHAT_SESSION_STORAGE_KEY, result.serialized);
    return { persisted: true, compacted: result.compacted, bytes: byteLength(result.serialized) };
  } catch {
    // The old unbounded value may itself occupy the origin quota. It is only a browser projection.
    const emergency = serializeWithinBudget(source, Math.min(budgetBytes, 64_000));
    try {
      storage.removeItem(CHAT_SESSION_STORAGE_KEY);
      storage.setItem(CHAT_SESSION_STORAGE_KEY, emergency.serialized);
      return { persisted: true, compacted: true, recoveredFromQuota: true, bytes: byteLength(emergency.serialized) };
    } catch {
      return { persisted: false, compacted: true, recoveredFromQuota: false, bytes: 0 };
    }
  }
}

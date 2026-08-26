export const CHAT_SESSION_STORAGE_KEY: string;

export interface ChatSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatSessionPersistenceResult {
  persisted: boolean;
  compacted: boolean;
  recoveredFromQuota?: boolean;
  bytes: number;
}

export function loadChatSessions(storage: ChatSessionStorage): Array<Record<string, any>>;
export function persistChatSessions(
  storage: ChatSessionStorage,
  sessions: Array<Record<string, any>>,
  options?: { budgetBytes?: number },
): ChatSessionPersistenceResult;

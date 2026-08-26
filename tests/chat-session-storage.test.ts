import { describe, expect, test } from 'bun:test';
import { CHAT_SESSION_STORAGE_KEY, loadChatSessions, persistChatSessions } from '../ui/morph-ui/shovs-frontend/src/store/chatSessionStorage.js';

class LimitedStorage {
  values = new Map<string, string>();
  constructor(private readonly quota: number) {}
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    const otherBytes = [...this.values].filter(([item]) => item !== key).reduce((total, [item, stored]) => total + item.length + stored.length, 0);
    if (otherBytes + key.length + value.length > this.quota) throw new DOMException('quota', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

const oversizedRun = { id: 'run:large', status: 'completed', events: Array.from({ length: 200 }, (_, index) => ({ index, payload: { raw: 'x'.repeat(10_000) } })) };

describe('chat session browser projection', () => {
  test('does not duplicate backend-owned transcripts or run trails', () => {
    const storage = new LimitedStorage(2_000_000);
    const result = persistChatSessions(storage, [{ id: 'session:one', backendSessionId: 'session:one', title: 'Canonical chat', updatedAt: 10, messages: [{ id: 'message:one', role: 'user', content: 'large '.repeat(20_000), at: 10 }], runs: [oversizedRun] }]);
    const stored = loadChatSessions(storage);
    expect(result.persisted).toBe(true); expect(stored[0].messages).toEqual([]); expect(stored[0].runs).toEqual([]); expect(stored[0].runCount).toBe(1);
    expect(storage.getItem(CHAT_SESSION_STORAGE_KEY)!.length).toBeLessThan(1_000);
  });

  test('keeps a bounded recent transcript for an offline device-only chat', () => {
    const storage = new LimitedStorage(2_000_000);
    persistChatSessions(storage, [{ id: 'local:one', title: 'Offline', updatedAt: 10, runs: [oversizedRun], messages: Array.from({ length: 40 }, (_, index) => ({ id: `message:${index}`, role: 'user', content: `${index}:` + 'x'.repeat(8_000), at: index })) }]);
    const [stored] = loadChatSessions(storage);
    expect(stored.messages).toHaveLength(24); expect(stored.messages[0].id).toBe('message:16'); expect(stored.messages[0].content.length).toBe(6_000); expect(stored.runs).toEqual([]);
  });

  test('recovers from an oversized legacy value without throwing', () => {
    const storage = new LimitedStorage(70_000); storage.values.set(CHAT_SESSION_STORAGE_KEY, 'x'.repeat(69_000));
    const sessions = Array.from({ length: 20 }, (_, index) => ({ id: `local:${index}`, title: `Chat ${index}`, updatedAt: index, messages: [{ id: `message:${index}`, role: 'user', content: 'y'.repeat(20_000), at: index }], runs: [oversizedRun] }));
    const result = persistChatSessions(storage, sessions);
    expect(result.persisted).toBe(true); expect(result.recoveredFromQuota).toBe(true); expect(loadChatSessions(storage).length).toBeGreaterThan(0);
  });

  test('fails closed when the origin cannot store even the emergency index', () => {
    const storage = new LimitedStorage(10); const result = persistChatSessions(storage, [{ id: 'local:one', title: 'Chat', updatedAt: 1 }]);
    expect(result.persisted).toBe(false); expect(() => loadChatSessions(storage)).not.toThrow();
  });
});

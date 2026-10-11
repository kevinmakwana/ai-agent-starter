/** Browser-side credentials. Customers keep one token per conversation; reviewers keep the console key for the tab. */
export interface StoredConversation { id: string; token: string; customerName: string; createdAt: string }

const CHATS = 'acme.conversations';
const REVIEWER = 'acme.reviewerKey';

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try { return JSON.parse(storage?.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}

export const loadChats = (): StoredConversation[] => read(globalThis.localStorage, CHATS, []);

export function saveChat(chat: StoredConversation): StoredConversation[] {
  const all = [chat, ...loadChats().filter((c) => c.id !== chat.id)].slice(0, 30);
  try { localStorage.setItem(CHATS, JSON.stringify(all)); } catch { /* storage unavailable: chat still works this session */ }
  return all;
}

export const loadReviewerKey = (): string => read(globalThis.sessionStorage, REVIEWER, '');
export function saveReviewerKey(key: string) {
  try { key ? sessionStorage.setItem(REVIEWER, JSON.stringify(key)) : sessionStorage.removeItem(REVIEWER); } catch { /* ignore */ }
}

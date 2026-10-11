import type { Approval, ConversationDetail, ConversationSummary, Customer } from './types';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message;
    throw new Error(Array.isArray(msg) ? msg.join(', ') : (msg ?? `Request failed (${res.status})`));
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => call<{ status: string; provider: string }>('/health'),
  customers: () => call<Customer[]>('/customers'),
  conversations: () => call<ConversationSummary[]>('/conversations'),
  conversation: (id: string) => call<ConversationDetail>(`/conversations/${id}`),
  createConversation: (customerId: number) => call<ConversationSummary>('/conversations', post({ customerId })),
  send: (id: string, content: string) => call<unknown>(`/conversations/${id}/messages`, post({ content })),
  approvals: () => call<Approval[]>('/approvals'),
  decide: (id: string, decision: 'approve' | 'reject', note?: string) =>
    call<unknown>(`/approvals/${id}`, post({ decision, note: note || undefined })),
};

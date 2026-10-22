import type { Approval, ApprovalEvent, ConversationDetail, ConversationSummary, Customer } from './types';

/** `token` = conversation access token (customers); `key` = reviewer API key (console). */
export interface Auth { token?: string; key?: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}, auth: Auth = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (auth.key) headers.authorization = `Bearer ${auth.key}`;
  if (auth.token) headers['x-conversation-token'] = auth.token;
  const res = await fetch(`/api${path}`, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message;
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : (msg ?? `Request failed (${res.status})`), res.status);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => call<{ status: string; provider: string; reviewerAuth: boolean }>('/health'),
  // customer
  startConversation: (who: { customerId: number } | { email: string }) =>
    call<ConversationSummary & { accessToken: string }>('/conversations', post(who)),
  conversation: (id: string, auth: Auth) => call<ConversationDetail>(`/conversations/${id}`, {}, auth),
  send: (id: string, content: string, auth: Auth) => call<unknown>(`/conversations/${id}/messages`, post({ content }), auth),
  // reviewer
  customers: (auth: Auth) => call<Customer[]>('/customers', {}, auth),
  conversations: (auth: Auth) => call<ConversationSummary[]>('/conversations', {}, auth),
  approvals: (auth: Auth) => call<Approval[]>('/approvals', {}, auth),
  decide: (id: string, decision: 'approve' | 'reject', note: string | undefined, auth: Auth) =>
    call<unknown>(`/approvals/${id}`, post({ decision, note: note || undefined }), auth),
  approvalEvents: (auth: Auth) => call<ApprovalEvent[]>('/approvals/events?limit=100', {}, auth),
};

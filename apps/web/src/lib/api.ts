import type { Approval, ApprovalEvent, ConversationDetail, ConversationSummary, Customer, CustomerMe, MyConversation, Reviewer } from './types';

/** `token` = conversation access token (customers); `key` = reviewer API key (console). */
export interface Auth { token?: string; key?: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function authHeaders(auth: Auth): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.key) headers.authorization = `Bearer ${auth.key}`;
  if (auth.token) headers['x-conversation-token'] = auth.token;
  return headers;
}

async function call<T>(path: string, init: RequestInit = {}, auth: Auth = {}): Promise<T> {
  const headers = authHeaders(auth);
  if (init.body) headers['content-type'] = 'application/json';
  // The session cookie rides along on every same-origin request, so any call that changes something proves it came from this
  // page. Sent whoever the caller is: a signed-in reviewer may also use the customer chat in the same browser.
  if (init.method && init.method !== 'GET') headers['x-requested-by'] = 'reviewer-console';
  const res = await fetch(`/api${path}`, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message;
    throw new ApiError(Array.isArray(msg) ? msg.join(', ') : (msg ?? `Request failed (${res.status})`), res.status);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });

export const api = {
  health: () => call<{ status: string; provider: string; reviewerAuth: boolean; reviewerAccounts: boolean; customerLogin?: boolean }>('/health'),
  // customer
  startConversation: (who: { customerId: number } | { email: string }) =>
    call<ConversationSummary & { accessToken: string }>('/conversations', post(who)),
  conversation: (id: string, auth: Auth) => call<ConversationDetail>(`/conversations/${id}`, {}, auth),
  send: (id: string, content: string, auth: Auth) => call<unknown>(`/conversations/${id}/messages`, post({ content }), auth),
  // customer login (cookie session; the CSRF header comes from call())
  customerRequestLink: (email: string) => call<{ status: string }>('/customer-auth/request', post({ email })),
  customerVerify: (token: string) => call<{ customer: CustomerMe }>('/customer-auth/verify', post({ token })),
  customerMe: () => call<{ customer: CustomerMe }>('/customer-auth/me'),
  customerLogout: () => call<null>('/customer-auth/logout', { method: 'POST' }),
  customerLogoutAll: () => call<null>('/customer-auth/logout-all', { method: 'POST' }),
  myConversations: () => call<MyConversation[]>('/my/conversations'),
  startMyConversation: () => call<ConversationSummary>('/conversations', post({})),
  // reviewer
  customers: (auth: Auth) => call<Customer[]>('/customers', {}, auth),
  conversations: (auth: Auth) => call<ConversationSummary[]>('/conversations', {}, auth),
  approvals: (auth: Auth) => call<Approval[]>('/approvals', {}, auth),
  decide: (id: string, decision: 'approve' | 'reject', note: string | undefined, auth: Auth) =>
    call<unknown>(`/approvals/${id}`, post({ decision, note: note || undefined }), auth),
  approvalEvents: (auth: Auth) => call<ApprovalEvent[]>('/approvals/events?limit=100', {}, auth),
  // reviewer accounts (cookie session: no credential travels in JS)
  login: (email: string, password: string) => call<{ reviewer: Reviewer }>('/auth/login', post({ email, password })),
  logout: () => call<null>('/auth/logout', { method: 'POST' }),
  me: () => call<{ reviewer: Reviewer }>('/auth/me'),
  changePassword: (current: string, next: string) => call<null>('/auth/password', post({ current, next })),
  reviewers: () => call<Reviewer[]>('/reviewers'),
  createReviewer: (r: { email: string; name: string; role: 'admin' | 'reviewer'; password: string }) => call<Reviewer>('/reviewers', post(r)),
  updateReviewer: (id: string, patchBody: { name?: string; role?: 'admin' | 'reviewer'; active?: boolean; password?: string }) =>
    call<Reviewer>(`/reviewers/${id}`, patch(patchBody)),
};

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalsPanel } from '@/components/ApprovalsPanel';
import { AuditLog } from '@/components/AuditLog';
import { ChangePassword } from '@/components/ChangePassword';
import { Chat } from '@/components/Chat';
import { ConversationList } from '@/components/ConversationList';
import { LoginForm } from '@/components/LoginForm';
import { ReviewersPanel } from '@/components/ReviewersPanel';
import { TopBar } from '@/components/TopBar';
import { TracePanel } from '@/components/TracePanel';
import { api, ApiError } from '@/lib/api';
import { useEventStream } from '@/lib/useEventStream';
import { createLatest, singleFlight } from '@/lib/refresh';
import { loadReviewerKey, saveReviewerKey } from '@/lib/session';
import type { Approval, ApprovalEvent, ConversationDetail, ConversationSummary, Reviewer } from '@/lib/types';

/**
 * Reviewer console: every conversation's trace plus the approvals queue. Three modes, decided by the API's /health:
 * reviewer accounts (email + password, session cookie), the shared REVIEWER_API_KEY, or open demo.
 */
export default function ReviewerConsole() {
  const [provider, setProvider] = useState('…');
  const [health, setHealth] = useState<{ reviewerAuth: boolean; reviewerAccounts: boolean } | null>(null);
  // The signed-in reviewer lives in React state only: the credential is an httpOnly cookie that scripts cannot read.
  const [me, setMe] = useState<Reviewer | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [key, setKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [tab, setTab] = useState<'trace' | 'approvals' | 'audit' | 'reviewers'>('trace');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKey(loadReviewerKey());
    api.health().then(async (h) => {
      setProvider(h.provider);
      let who: Reviewer | null = null;
      if (h.reviewerAccounts) who = (await api.me().catch(() => null))?.reviewer ?? null;
      // together, so the console never flashes the login form for an already signed-in reviewer
      setMe(who); setHealth(h);
    }).catch(() => setProvider('offline'));
  }, []);

  const accounts = health?.reviewerAccounts === true;
  const needsKey = !accounts && health?.reviewerAuth === true;
  const auth = accounts ? {} : { key };
  const locked = health === null || (accounts ? me === null : needsKey && !key);

  /** A 401 means the credential is gone (rejected key, or a session that ended): back to the login form. */
  const handleUnauthorized = () => {
    if (accounts) {
      setMe(null); setTab('trace'); setSelectedId(null); setDetail(null); setApprovals([]); setConversations([]); setEvents([]);
      setSessionNotice('Your session ended. Sign in again.');
    } else {
      saveReviewerKey(''); setKey(''); setLoginError('That key was rejected.');
    }
  };

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Latest wins: a response that a newer request has overtaken never overwrites it.
  const listSeq = useRef(createLatest()).current; // conversations, approvals, audit events
  const detailSeq = useRef(createLatest()).current;

  const load = async (skipDetail: boolean) => {
    if (locked) return;
    const listCurrent = listSeq.next();
    const detailCurrent = selectedId && !skipDetail ? detailSeq.next() : null;
    try {
      const [list, apps, d, evs] = await Promise.all([
        api.conversations(auth),
        api.approvals(auth),
        selectedId && !skipDetail ? api.conversation(selectedId, auth) : Promise.resolve(null),
        tab === 'audit' ? api.approvalEvents(auth) : Promise.resolve(null),
      ]);
      if (listCurrent()) {
        setConversations(list); setApprovals(apps); setError(null);
        if (evs) setEvents(evs);
      }
      // ...and a detail for a conversation the user has since left is dropped too.
      if (d && detailCurrent?.() && d.conversation.id === selectedIdRef.current) setDetail(d);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) handleUnauthorized();
      else setError(e instanceof Error ? e.message : String(e));
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  // One refresh at a time, with a single trailing re-run for whatever arrived meanwhile: every event from any
  // conversation refetches the list and approvals, so this bounds the request rate under a burst. A queued refresh
  // that wants the detail is not downgraded by a later one that does not.
  const flight = useRef(singleFlight((skipDetail: boolean) => loadRef.current(skipDetail), (queued, next) => queued && next)).current;
  // Changing identity with the inputs is what makes the effect below refetch when the key, selection or tab changes.
  const refresh = useCallback((skipDetail = false) => flight(skipDetail), [flight, locked, key, me, selectedId, tab]);

  const stream = useEventStream(
    locked ? null : { path: '/events', auth },
    (changes) => {
      const detailAffected = changes.some((c) => c.kind === 'resync' || c.conversationId === selectedIdRef.current);
      void refresh(!detailAffected);
    },
  );

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while the live stream is not up.
  useEffect(() => {
    if (stream === 'live') return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh, stream]);

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    saveReviewerKey(keyInput.trim());
    setKey(keyInput.trim()); setKeyInput(''); setLoginError(null);
  };

  const decide = async (id: string, decision: 'approve' | 'reject', note: string) => {
    try { await api.decide(id, decision, note, auth); } catch (e) {
      if (e instanceof ApiError && e.status === 401) handleUnauthorized();
      else setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  const logout = async () => {
    await api.logout().catch(() => undefined); // the session may already be gone; either way we are signed out here
    handleUnauthorized();
    setSessionNotice(null);
  };

  if (accounts && !me) {
    return (
      <div className="app login">
        <TopBar provider={provider} mode="reviewer" />
        <LoginForm notice={sessionNotice} onSignedIn={(r) => { setMe(r); setSessionNotice(null); setError(null); }} />
      </div>
    );
  }

  if (needsKey && !key) {
    return (
      <div className="app login">
        <TopBar provider={provider} mode="reviewer" />
        <form className="panel login-card" onSubmit={login}>
          <h1>Reviewer sign-in</h1>
          <p className="muted">This API requires the reviewer key (<code>REVIEWER_API_KEY</code>). It is kept in this tab only.</p>
          <input type="password" aria-label="Reviewer key" placeholder="Reviewer key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoFocus />
          {loginError && <div className="notice err">{loginError}</div>}
          <button className="btn primary" disabled={!keyInput.trim()}>Sign in</button>
        </form>
      </div>
    );
  }

  const pendingCount = approvals.filter((a) => a.status === 'pending_approval').length;
  return (
    <div className="app">
      <TopBar
        provider={provider} mode="reviewer" stream={stream}
        account={me ? { name: me.name, onLogout: () => void logout(), onChangePassword: () => setChangingPassword(true) } : null}
      />
      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
      <ConversationList conversations={conversations} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setDetail(null); setTab('trace'); }} />
      <Chat detail={detail} customer={undefined} sending={false} optimistic={null} error={error} readOnly onReview={() => setTab('approvals')} />
      <section className="panel side">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>Trace</button>
          <button role="tab" aria-selected={tab === 'approvals'} className={tab === 'approvals' ? 'on' : ''} onClick={() => setTab('approvals')}>
            Approvals {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>
          {me?.role === 'admin' && (
            <button role="tab" aria-selected={tab === 'reviewers'} className={tab === 'reviewers' ? 'on' : ''} onClick={() => setTab('reviewers')}>Reviewers</button>
          )}
        </div>
        <div className="side-body">
          {tab === 'trace' && <TracePanel detail={detail} />}
          {tab === 'approvals' && <ApprovalsPanel approvals={approvals} me={me} onDecide={decide} />}
          {tab === 'audit' && <AuditLog events={events} />}
          {tab === 'reviewers' && me && <ReviewersPanel me={me} onUnauthorized={handleUnauthorized} />}
        </div>
      </section>
    </div>
  );
}

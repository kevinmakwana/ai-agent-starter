'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalsPanel } from '@/components/ApprovalsPanel';
import { AuditLog } from '@/components/AuditLog';
import { Chat } from '@/components/Chat';
import { ConversationList } from '@/components/ConversationList';
import { TopBar } from '@/components/TopBar';
import { TracePanel } from '@/components/TracePanel';
import { api, ApiError } from '@/lib/api';
import { loadReviewerKey, saveReviewerKey } from '@/lib/session';
import type { Approval, ApprovalEvent, ConversationDetail, ConversationSummary } from '@/lib/types';

/** Reviewer console: every conversation's trace plus the approvals queue. Gated by REVIEWER_API_KEY when set. */
export default function ReviewerConsole() {
  const [provider, setProvider] = useState('…');
  const [needsKey, setNeedsKey] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [tab, setTab] = useState<'trace' | 'approvals' | 'audit'>('trace');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKey(loadReviewerKey());
    api.health().then((h) => { setProvider(h.provider); setNeedsKey(h.reviewerAuth); }).catch(() => setProvider('offline'));
  }, []);

  const locked = needsKey === null || (needsKey && !key);

  const refresh = useCallback(async () => {
    if (locked) return;
    const auth = { key };
    try {
      const [list, apps, d, evs] = await Promise.all([
        api.conversations(auth),
        api.approvals(auth),
        selectedId ? api.conversation(selectedId, auth) : Promise.resolve(null),
        tab === 'audit' ? api.approvalEvents(auth) : Promise.resolve(null),
      ]);
      setConversations(list); setApprovals(apps); setError(null);
      if (d) setDetail(d);
      if (evs) setEvents(evs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { saveReviewerKey(''); setKey(''); setLoginError('That key was rejected.'); }
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [locked, key, selectedId, tab]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    saveReviewerKey(keyInput.trim());
    setKey(keyInput.trim()); setKeyInput(''); setLoginError(null);
  };

  const decide = async (id: string, decision: 'approve' | 'reject', note: string) => {
    try { await api.decide(id, decision, note, { key }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    await refresh();
  };

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
      <TopBar provider={provider} mode="reviewer" />
      <ConversationList conversations={conversations} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setDetail(null); setTab('trace'); }} />
      <Chat detail={detail} customer={undefined} sending={false} optimistic={null} error={error} readOnly onReview={() => setTab('approvals')} />
      <section className="panel side">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>Trace</button>
          <button role="tab" aria-selected={tab === 'approvals'} className={tab === 'approvals' ? 'on' : ''} onClick={() => setTab('approvals')}>
            Approvals {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>
        </div>
        <div className="side-body">
          {tab === 'trace' && <TracePanel detail={detail} />}
          {tab === 'approvals' && <ApprovalsPanel approvals={approvals} onDecide={decide} />}
          {tab === 'audit' && <AuditLog events={events} />}
        </div>
      </section>
    </div>
  );
}

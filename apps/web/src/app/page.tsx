'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApprovalsPanel } from '@/components/ApprovalsPanel';
import { Chat } from '@/components/Chat';
import { ConversationList } from '@/components/ConversationList';
import { TracePanel } from '@/components/TracePanel';
import { api } from '@/lib/api';
import type { Approval, ConversationDetail, ConversationSummary, Customer } from '@/lib/types';

export default function Home() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [tab, setTab] = useState<'trace' | 'approvals'>('trace');
  const [provider, setProvider] = useState<string>('…');
  const [sending, setSending] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, apps, d] = await Promise.all([
        api.conversations(),
        api.approvals(),
        selectedId ? api.conversation(selectedId) : Promise.resolve(null),
      ]);
      setConversations(list);
      setApprovals(apps);
      if (d) setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? `Cannot reach the API: ${e.message}` : String(e));
    }
  }, [selectedId]);

  useEffect(() => {
    api.customers().then(setCustomers).catch((e) => setError(String(e.message ?? e)));
    api.health().then((h) => setProvider(h.provider)).catch(() => setProvider('offline'));
  }, []);

  // Poll: fast while a run is executing (live trace), slower otherwise.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, sending ? 500 : 3000);
    return () => clearInterval(t);
  }, [refresh, sending]);

  const select = (id: string) => { setSelectedId(id); setDetail(null); setError(null); setTab('trace'); };

  const create = async (customerId: number) => {
    const c = await api.createConversation(customerId);
    select(c.id);
  };

  const send = async (text: string) => {
    if (!selectedId) return;
    setSending(true); setOptimistic(text); setError(null);
    try {
      await api.send(selectedId, text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false); setOptimistic(null);
      await refresh();
    }
  };

  const decide = async (id: string, decision: 'approve' | 'reject', note: string) => {
    try {
      await api.decide(id, decision, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  const pendingCount = approvals.filter((a) => a.status === 'pending_approval').length;
  const customer = customers.find((c) => c.id === detail?.conversation.customerId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">A</span> Acme Shop <small>support agent</small></div>
        <span className="chip provider">LLM: {provider}</span>
      </header>
      <ConversationList conversations={conversations} customers={customers} selectedId={selectedId} onSelect={select} onCreate={create} />
      <Chat detail={detail} customer={customer} sending={sending} optimistic={optimistic} error={error} onSend={send} onReview={() => setTab('approvals')} />
      <section className="panel side">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>Trace</button>
          <button role="tab" aria-selected={tab === 'approvals'} className={tab === 'approvals' ? 'on' : ''} onClick={() => setTab('approvals')}>
            Approvals {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
        </div>
        <div className="side-body">
          {tab === 'trace' ? <TracePanel detail={detail} /> : <ApprovalsPanel approvals={approvals} onDecide={decide} />}
        </div>
      </section>
    </div>
  );
}

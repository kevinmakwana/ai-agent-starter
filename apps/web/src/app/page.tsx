'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Chat } from '@/components/Chat';
import { ConversationList } from '@/components/ConversationList';
import { TopBar } from '@/components/TopBar';
import { api } from '@/lib/api';
import { createLatest } from '@/lib/refresh';
import { useEventStream } from '@/lib/useEventStream';
import { loadChats, saveChat, type StoredConversation } from '@/lib/session';
import type { ConversationDetail, ConversationSummary, Customer } from '@/lib/types';

/** Customer-facing chat. It only ever holds the tokens of conversations this browser started. */
export default function CustomerChat() {
  const [chats, setChats] = useState<StoredConversation[]>([]);
  const [customers, setCustomers] = useState<Customer[] | null>(null); // null = still loading
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [provider, setProvider] = useState('…');
  const [sending, setSending] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = chats.find((c) => c.id === selectedId);
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  useEffect(() => {
    setChats(loadChats());
    api.health().then((h) => setProvider(h.provider)).catch(() => setProvider('offline'));
    // Demo convenience: the customer directory is only listable while reviewer auth is off.
    api.customers({}).then(setCustomers).catch(() => setCustomers([]));
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailSeq = useRef(createLatest()).current;

  const refresh = useCallback(async () => {
    if (!selected) return;
    const current = detailSeq.next();
    try {
      const d = await api.conversation(selected.id, { token: selected.token });
      // Drop a response that a newer refresh has overtaken, or that belongs to a chat the user has since left.
      if (current() && d.conversation.id === selectedIdRef.current) setDetail(d);
    } catch (e) {
      if (current()) setError(message(e));
    }
  }, [selected, detailSeq]);

  const stream = useEventStream(
    selected ? { path: `/conversations/${selected.id}/events`, auth: { token: selected.token } } : null,
    () => { void refresh(); },
  );

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while the live stream is not up. `live` is reported on the first bytes of the body, so a proxy that
  // buffers SSE never gets there and the page degrades to the old polling.
  useEffect(() => {
    if (stream === 'live') return;
    const t = setInterval(refresh, sending ? 500 : 3000);
    return () => clearInterval(t);
  }, [refresh, sending, stream]);

  const select = (id: string) => { setSelectedId(id); setDetail(null); setError(null); };

  const start = async (who: { customerId: number } | { email: string }) => {
    try {
      const c = await api.startConversation(who);
      setChats(saveChat({ id: c.id, token: c.accessToken, customerName: c.customerName, createdAt: c.createdAt }));
      select(c.id);
    } catch (e) {
      setError(message(e));
    }
  };

  const send = async (text: string) => {
    if (!selected) return;
    setSending(true); setOptimistic(text); setError(null);
    try {
      await api.send(selected.id, text, { token: selected.token });
    } catch (e) {
      setError(message(e));
    } finally {
      setSending(false); setOptimistic(null);
      await refresh();
    }
  };

  const summaries: ConversationSummary[] = chats.map((c) => ({
    id: c.id, customerName: c.customerName, createdAt: c.createdAt, customerId: 0, customerEmail: '', title: '',
    lastStatus: null, pendingApprovals: c.id === selectedId && detail?.runs.at(-1)?.status === 'awaiting_approval' ? 1 : 0,
  }));
  const customer = customers?.find((c) => c.id === detail?.conversation.customerId);

  return (
    <div className="app customer">
      <TopBar provider={provider} mode="customer" stream={selected ? stream : undefined} />
      <ConversationList conversations={summaries} customers={customers} selectedId={selectedId} onSelect={select} onCreate={start} />
      <Chat detail={detail} customer={customer} sending={sending} optimistic={optimistic} error={error} onSend={send} />
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Chat } from '@/components/Chat';
import { ConversationList } from '@/components/ConversationList';
import { CustomerSignIn } from '@/components/CustomerSignIn';
import { TopBar } from '@/components/TopBar';
import { ApiError, api } from '@/lib/api';
import { customerScreen } from '@/lib/customer-view';
import { createLatest } from '@/lib/refresh';
import { useEventStream } from '@/lib/useEventStream';
import { loadChats, saveChat, type StoredConversation } from '@/lib/session';
import type { ConversationDetail, ConversationSummary, Customer, CustomerMe, MyConversation } from '@/lib/types';

/**
 * Customer-facing chat. With customer login off it only ever holds the tokens of conversations this browser started.
 * With login on (the API says so in /health) the customer signs in by emailed link and the session replaces the tokens.
 */
export default function CustomerChat() {
  const [storedChats, setStoredChats] = useState<StoredConversation[]>([]);
  const [customers, setCustomers] = useState<Customer[] | null>(null); // null = still loading
  const [health, setHealth] = useState<{ customerLogin?: boolean } | null>(null); // null = not answered yet
  const [me, setMe] = useState<CustomerMe | null>(null);
  const [myChats, setMyChats] = useState<MyConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [provider, setProvider] = useState('…');
  const [sending, setSending] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loginMode = health?.customerLogin === true;
  // Login mode lists the customer's own conversations from the API; there are no tokens to hold.
  const chats: StoredConversation[] = loginMode
    ? myChats.map((c) => ({ id: c.id, token: '', customerName: me?.name ?? '', createdAt: c.createdAt }))
    : storedChats;
  const authFor = (c: StoredConversation) => (loginMode ? {} : { token: c.token });

  const selected = chats.find((c) => c.id === selectedId);
  // Login mode rebuilds `chats` on every render, so depend on these two strings, never on the `selected` object itself:
  // a new object each render would re-run the refresh effect every time and hammer the API until it answers 429.
  const selectedChatId = selected?.id;
  const selectedToken = selected?.token;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  useEffect(() => {
    (async () => {
      try {
        const h = await api.health();
        setProvider(h.provider);
        if (h.customerLogin) {
          const who = await api.customerMe().then((r) => r.customer).catch(() => null);
          setMe(who);
          if (who) setMyChats(await api.myConversations().catch(() => []));
        } else {
          setStoredChats(loadChats());
          // Demo convenience: the customer directory is only listable while reviewer auth is off.
          api.customers({}).then(setCustomers).catch(() => setCustomers([]));
        }
        setHealth(h); // after `me`, so the sign-in form never flashes for someone who is signed in
      } catch {
        setProvider('offline');
        setStoredChats(loadChats());
        api.customers({}).then(setCustomers).catch(() => setCustomers([]));
        setHealth({ customerLogin: false });
      }
    })();
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailSeq = useRef(createLatest()).current;

  /** The session ended (expired, logged out in another tab): back to the sign-in form. */
  const sessionEnded = useCallback(() => {
    setMe(null); setSelectedId(null); setDetail(null); setMyChats([]);
  }, []);

  const refresh = useCallback(async () => {
    if (!selectedChatId) return;
    const current = detailSeq.next();
    try {
      const d = await api.conversation(selectedChatId, loginMode ? {} : { token: selectedToken });
      // Drop a response that a newer refresh has overtaken, or that belongs to a chat the user has since left.
      if (current() && d.conversation.id === selectedIdRef.current) setDetail(d);
      // keeps the "waiting for approval" chip in the list current; a failed refresh keeps the list as it was
      if (loginMode) await api.myConversations().then(setMyChats).catch(() => undefined);
    } catch (e) {
      if (loginMode && e instanceof ApiError && e.status === 401) { sessionEnded(); return; }
      if (current()) setError(message(e));
    }
  }, [selectedChatId, selectedToken, detailSeq, loginMode, sessionEnded]);

  const stream = useEventStream(
    selectedChatId ? { path: `/conversations/${selectedChatId}/events`, auth: loginMode ? {} : { token: selectedToken } } : null,
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
      setStoredChats(saveChat({ id: c.id, token: c.accessToken, customerName: c.customerName, createdAt: c.createdAt }));
      select(c.id);
    } catch (e) {
      setError(message(e));
    }
  };

  const startMine = async () => {
    try {
      const c = await api.startMyConversation();
      setMyChats(await api.myConversations());
      select(c.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) sessionEnded(); else setError(message(e));
    }
  };

  const send = async (text: string) => {
    if (!selected) return;
    setSending(true); setOptimistic(text); setError(null);
    try {
      await api.send(selected.id, text, authFor(selected));
    } catch (e) {
      if (loginMode && e instanceof ApiError && e.status === 401) sessionEnded(); else setError(message(e));
    } finally {
      setSending(false); setOptimistic(null);
      await refresh();
    }
  };

  const signOut = async (everywhere: boolean) => {
    await (everywhere ? api.customerLogoutAll() : api.customerLogout()).catch(() => undefined);
    sessionEnded();
  };

  const screen = customerScreen(health, me);
  if (screen === 'loading') return <div className="app" />;
  if (screen === 'sign-in') {
    return (
      <div className="app login">
        <TopBar provider={provider} mode="customer" />
        <CustomerSignIn />
      </div>
    );
  }

  const summaries: ConversationSummary[] = loginMode
    ? myChats.map((c) => ({
        id: c.id, customerName: me?.name ?? '', createdAt: c.createdAt, customerId: 0, customerEmail: '', title: c.title,
        lastStatus: c.lastStatus, pendingApprovals: c.awaitingApproval ? 1 : 0,
      }))
    : storedChats.map((c) => ({
        id: c.id, customerName: c.customerName, createdAt: c.createdAt, customerId: 0, customerEmail: '', title: '',
        lastStatus: null, pendingApprovals: c.id === selectedId && detail?.runs.at(-1)?.status === 'awaiting_approval' ? 1 : 0,
      }));
  const customer = customers?.find((c) => c.id === detail?.conversation.customerId);

  return (
    <div className="app customer">
      <TopBar
        provider={provider}
        mode="customer"
        stream={selected ? stream : undefined}
        account={loginMode && me ? { name: me.name, onLogout: () => void signOut(false), onLogoutAll: () => void signOut(true) } : null}
      />
      {loginMode ? (
        <ConversationList conversations={summaries} selectedId={selectedId} onSelect={select} onNew={() => void startMine()} />
      ) : (
        <ConversationList conversations={summaries} customers={customers} selectedId={selectedId} onSelect={select} onCreate={start} />
      )}
      <Chat detail={detail} customer={customer} sending={sending} optimistic={optimistic} error={error} onSend={send} />
    </div>
  );
}

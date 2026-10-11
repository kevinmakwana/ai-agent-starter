import { useEffect, useRef, useState } from 'react';
import type { ConversationDetail, Customer } from '@/lib/types';

interface Props {
  detail: ConversationDetail | null;
  customer: Customer | undefined;
  sending: boolean;
  optimistic: string | null;
  error: string | null;
  onSend?: (text: string) => void;
  /** Reviewer console: show the transcript only, with a shortcut to the approvals tab. */
  onReview?: () => void;
  readOnly?: boolean;
}

export function Chat({ detail, customer, sending, optimistic, error, onSend, onReview, readOnly }: Props) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [detail, optimistic, sending]);

  if (!detail) {
    return (
      <main className="panel chat">
        <div className="placeholder">
          <h1>Acme Shop support agent</h1>
          <p>{readOnly ? 'Select a conversation to read its transcript and trace.' : 'Start a conversation on the left. The agent answers by calling tools against Postgres; refunds wait for a human.'}</p>
        </div>
      </main>
    );
  }

  const runs = detail.runs;
  const last = runs[runs.length - 1];
  const paused = last?.status === 'awaiting_approval';
  // the polled trace already shows the message once the run row exists
  const echoed = last?.status === 'running' && last.steps[0]?.content === optimistic;
  const o = customer?.firstOrderId;
  const suggestions = [
    'Show my recent orders',
    o ? `Order #${o} arrived damaged, please refund it` : 'I need a refund for my last order',
    o ? `Show me order #${o === 2 ? 3 : 2}` : 'Show me order #2',
    'Open a ticket: my parcel is late',
  ];
  const submit = (t: string) => { if (t.trim() && !sending && !paused) { onSend?.(t.trim()); setText(''); } };

  return (
    <main className="panel chat">
      <div className="panel-head">
        <h2>{detail.conversation.customerName}</h2>
        <span className="muted">{detail.conversation.customerEmail} · customer #{detail.conversation.customerId}</span>
      </div>
      <div className="messages">
        {runs.flatMap((run) => run.steps.filter((s) => s.role === 'user' || (s.role === 'assistant' && !s.toolName)).map((s) => (
          <div key={s.id} className={`bubble ${s.role}`}>{s.content}</div>
        )))}
        {optimistic && !echoed && <div className="bubble user">{optimistic}</div>}
        {sending && <div className="bubble assistant typing"><i /><i /><i /></div>}
        {paused && (
          <div className="notice warn">
            ⏸ A refund is waiting for human approval.{' '}
            {onReview ? <button className="link" onClick={onReview}>Review it →</button> : 'A reviewer will decide shortly.'}
          </div>
        )}
        {last?.status === 'failed' && <div className="notice err">The run failed: {last.error}</div>}
        {error && <div className="notice err">{error}</div>}
        <div ref={endRef} />
      </div>
      {!readOnly && (
        <>
          <div className="suggestions">
            {suggestions.map((s) => <button key={s} className="chip-btn" disabled={sending || paused} onClick={() => submit(s)}>{s}</button>)}
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={paused ? 'Waiting for a reviewer to decide…' : 'Ask about an order, a refund, a ticket…'}
              disabled={sending || paused}
              aria-label="Message"
            />
            <button className="btn primary" disabled={sending || paused || !text.trim()}>Send</button>
          </form>
        </>
      )}
    </main>
  );
}

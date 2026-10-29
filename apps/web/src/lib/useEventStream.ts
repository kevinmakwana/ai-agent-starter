'use client';

import { useEffect, useRef, useState } from 'react';
import { authHeaders, type Auth } from './api';
import { openStream, type StreamStatus } from './stream';

export interface StreamChange { kind: string; conversationId?: string }

/**
 * Subscribes to a server-sent-event stream and reports the changes it signals, coalesced over `debounceMs` so a
 * burst of steps causes one refetch. Every (re)connect reports a `resync`: whatever was missed meanwhile is
 * refetched. Returns the connection status; callers poll while it is not `live`.
 */
export function useEventStream(
  target: { path: string; auth: Auth } | null,
  onChange: (changes: StreamChange[]) => void,
  debounceMs = 100,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>(target ? 'connecting' : 'down');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const path = target?.path;
  const token = target?.auth.token;
  const key = target?.auth.key;

  useEffect(() => {
    if (!path) { setStatus('down'); return; }
    setStatus('connecting');
    let pending: StreamChange[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      if (batch.length) onChangeRef.current(batch);
    };
    const queue = (change: StreamChange) => {
      pending.push(change);
      if (!timer) timer = setTimeout(flush, debounceMs);
    };
    const close = openStream(`/api${path}`, authHeaders({ token, key }), {
      onStatus: (s) => { setStatus(s); if (s === 'live') queue({ kind: 'resync' }); },
      onMessage: (m) => {
        let conversationId: string | undefined;
        try { conversationId = JSON.parse(m.data)?.conversationId; } catch { /* a bad payload still counts as a change */ }
        queue({ kind: m.event, conversationId });
      },
    });
    return () => { close(); clearTimeout(timer); };
  }, [path, token, key, debounceMs]);

  return status;
}

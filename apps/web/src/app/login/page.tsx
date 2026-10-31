'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { readLoginToken } from '@/lib/login-fragment';

/** Landing page of the emailed link: redeems the token from the fragment, then goes to the chat. */
export default function LoginPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const started = useRef(false); // development double-mounts effects, and a link works only once

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readLoginToken(window.location.hash);
    history.replaceState(null, '', window.location.pathname); // the token leaves the address bar first
    if (!token) { setFailed(true); return; }
    api.customerVerify(token).then(() => router.replace('/')).catch(() => setFailed(true));
  }, [router]);

  return (
    <div className="app login">
      <div className="panel login-card">
        {failed ? (
          <>
            <h1>This link did not work</h1>
            <p className="muted">It may have expired or already been used. Request a new one.</p>
            <button className="btn primary" onClick={() => router.replace('/')}>Back to sign in</button>
          </>
        ) : (
          <h1>Signing you in…</h1>
        )}
      </div>
    </div>
  );
}

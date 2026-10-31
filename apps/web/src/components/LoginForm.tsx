import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Reviewer } from '@/lib/types';

/** Email + password sign-in. The password lives in this component's state only until the request is sent. */
export function LoginForm({ notice, onSignedIn }: { notice: string | null; onSignedIn: (r: Reviewer) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { reviewer } = await api.login(email.trim(), password);
      setPassword('');
      onSignedIn(reviewer);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel login-card" onSubmit={submit}>
      <h1>Reviewer sign-in</h1>
      <p className="muted">Sign in with your reviewer account. Your session ends when you log out, after 30 idle minutes, or after its lifetime.</p>
      <input type="email" aria-label="Email" placeholder="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      <input type="password" aria-label="Password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {(error ?? notice) && <div className="notice err" role="alert">{error ?? notice}</div>}
      <button className="btn primary" disabled={busy || !email.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}

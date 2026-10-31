import { useState } from 'react';
import { api } from '@/lib/api';

/** Asks for a sign-in link. The answer is the same for every email, so the page never says whether one is registered. */
export function CustomerSignIn() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.customerRequestLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="panel login-card">
        <h1>Check your inbox</h1>
        <p className="muted">If that email belongs to a customer account, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
        <button className="btn" onClick={() => setSent(false)}>Use a different email</button>
      </div>
    );
  }
  return (
    <form className="panel login-card" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">Enter your account email and we will send you a one-time sign-in link.</p>
      <input type="email" aria-label="Email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      {error && <div className="notice err" role="alert">{error}</div>}
      <button className="btn primary" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send me a sign-in link'}</button>
    </form>
  );
}

import { useState } from 'react';
import { api } from '@/lib/api';

/** Change your own password. Your other sessions end; this one stays. */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setCurrent(''); setNext(''); setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="panel modal" onSubmit={submit} role="dialog" aria-label="Change password">
        <h2>Change password</h2>
        {done ? (
          <>
            <div className="notice ok">Password changed. Your other sessions were signed out.</div>
            <button type="button" className="btn primary" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <input type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
            <input type="password" aria-label="New password" placeholder="New password (12+ characters)" autoComplete="new-password" minLength={12} maxLength={200} value={next} onChange={(e) => setNext(e.target.value)} required />
            {error && <div className="notice err" role="alert">{error}</div>}
            <div className="row-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || !current || next.length < 12}>{busy ? 'Saving…' : 'Change password'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

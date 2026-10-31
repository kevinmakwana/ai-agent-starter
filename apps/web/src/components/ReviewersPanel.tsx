import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Reviewer } from '@/lib/types';

/** Admin tab: list, add, change role, deactivate/reactivate and reset the password of reviewers. No password is ever shown or kept. */
export function ReviewersPanel({ me, onUnauthorized }: { me: Reviewer; onUnauthorized: () => void }) {
  const [rows, setRows] = useState<Reviewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', name: '', role: 'reviewer' as Reviewer['role'], password: '' });
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return onUnauthorized();
    setError(e instanceof Error ? e.message : String(e));
  }, [onUnauthorized]);

  const reload = useCallback(() => api.reviewers().then((r) => { setRows(r); setError(null); }).catch(fail), [fail]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await reload(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createReviewer({ ...form, email: form.email.trim(), name: form.name.trim() });
      setForm({ email: '', name: '', role: 'reviewer', password: '' });
    });
  };

  const savePassword = (id: string) => run(async () => {
    await api.updateReviewer(id, { password: resetPassword });
    setResetFor(null); setResetPassword('');
  });

  return (
    <div className="reviewers">
      {error && <div className="notice err" role="alert">{error}</div>}
      <ul className="reviewer-list">
        {rows.map((r) => (
          <li key={r.id} className={r.active ? '' : 'inactive'}>
            <div>
              <b>{r.name}</b>{r.id === me.id && <span className="muted"> (you)</span>}
              <div className="muted">{r.email} · {r.active ? 'active' : 'deactivated'}{r.lastLoginAt ? ` · last sign-in ${new Date(r.lastLoginAt).toLocaleString()}` : ''}</div>
            </div>
            <div className="row-actions">
              <select aria-label={`Role of ${r.name}`} value={r.role} disabled={busy} onChange={(e) => void run(() => api.updateReviewer(r.id, { role: e.target.value as Reviewer['role'] }))}>
                <option value="reviewer">reviewer</option>
                <option value="admin">admin</option>
              </select>
              <button className="btn" disabled={busy} onClick={() => void run(() => api.updateReviewer(r.id, { active: !r.active }))}>{r.active ? 'Deactivate' : 'Reactivate'}</button>
              <button className="btn" disabled={busy} onClick={() => { setResetFor(resetFor === r.id ? null : r.id); setResetPassword(''); }}>Set password</button>
            </div>
            {resetFor === r.id && (
              <form className="row-actions" onSubmit={(e) => { e.preventDefault(); void savePassword(r.id); }}>
                <input type="password" aria-label={`New password for ${r.name}`} placeholder="New password (12+ characters)" autoComplete="new-password" minLength={12} maxLength={200} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} />
                <button className="btn primary" disabled={busy || resetPassword.length < 12}>Save</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form className="add-reviewer" onSubmit={add}>
        <h3>Add a reviewer</h3>
        <input type="email" aria-label="New reviewer email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input aria-label="New reviewer name" placeholder="Name" maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select aria-label="New reviewer role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Reviewer['role'] })}>
          <option value="reviewer">reviewer</option>
          <option value="admin">admin</option>
        </select>
        <input type="password" aria-label="New reviewer password" placeholder="Password (12+ characters)" autoComplete="new-password" minLength={12} maxLength={200} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <button className="btn primary" disabled={busy || !form.email.trim() || !form.name.trim() || form.password.length < 12}>Add reviewer</button>
      </form>
    </div>
  );
}

import type { Pool } from 'pg';
import { PgAgentStore } from './pg-agent.store';

const C = 'c1';
const notice = (kind: string) => `NOTIFY ${JSON.stringify({ kind, conversationId: C })}`;

/** Records statements as short labels; `respond` returns rows for a statement, or an Error to make it fail. */
function fakePool(respond: (text: string) => any[] | Error) {
  const calls: string[] = [];
  const run = async (text: string, values?: unknown[]) => {
    const label = /^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text) ? text.trim().split(/\s+/)[0]
      : text.includes('pg_notify') ? `NOTIFY ${values?.[1]}`
      : text.trim().split(/\s+/).slice(0, 3).join(' ');
    calls.push(label);
    const out = respond(text);
    if (out instanceof Error) throw out;
    return { rows: out, rowCount: out.length };
  };
  const pool = { query: run, connect: async () => ({ query: run, release: () => undefined }) } as unknown as Pool;
  return { pool, calls };
}

const stepRow = { id: 1, run_id: 'r1', conversation_id: C, role: 'user' };
const actionRow = { id: 'a1', run_id: 'r1', conversation_id: C, tool_name: 'issue_refund', tool_args: {}, status: 'approved' };
const eventRow = { id: 1, kind: 'approved', conversation_id: C };

describe('PgAgentStore change signals', () => {
  it('addStep publishes trace inside its transaction, before COMMIT', async () => {
    const { pool, calls } = fakePool(() => [stepRow]);
    await new PgAgentStore(pool).addStep({ runId: 'r1', conversationId: C, role: 'user', content: 'hi' });
    expect(calls).toEqual(['BEGIN', 'INSERT INTO steps', notice('trace'), 'COMMIT']);
  });

  it('decideAction publishes trace, approvals and audit before COMMIT', async () => {
    const { pool, calls } = fakePool((t) => (t.includes('UPDATE actions') ? [actionRow] : [eventRow]));
    await new PgAgentStore(pool).decideAction('a1', 'approved', 'ok');
    expect(calls).toEqual([
      'BEGIN', 'UPDATE actions SET', 'INSERT INTO approval_events', notice('audit'), notice('trace'), notice('approvals'), 'COMMIT',
    ]);
  });

  it('decideAction publishes nothing when the action was already decided', async () => {
    const { pool, calls } = fakePool(() => []);
    expect(await new PgAgentStore(pool).decideAction('a1', 'approved')).toBeNull();
    expect(calls.filter((c) => c.startsWith('NOTIFY'))).toEqual([]);
  });

  it('a failed write rolls back and never publishes or commits', async () => {
    const { pool, calls } = fakePool((t) => (t.includes('approval_events') ? new Error('boom') : [actionRow]));
    await expect(new PgAgentStore(pool).decideAction('a1', 'approved')).rejects.toThrow('boom');
    expect(calls).toEqual(['BEGIN', 'UPDATE actions SET', 'INSERT INTO approval_events', 'ROLLBACK']);
  });

  it('reopenAction publishes trace and approvals only when a row was reopened', async () => {
    const reopened = fakePool(() => [{ conversation_id: C }]);
    await new PgAgentStore(reopened.pool).reopenAction('a1');
    expect(reopened.calls).toEqual(['BEGIN', 'UPDATE actions SET', notice('trace'), notice('approvals'), 'COMMIT']);
    const untouched = fakePool(() => []);
    await new PgAgentStore(untouched.pool).reopenAction('a1');
    expect(untouched.calls.filter((c) => c.startsWith('NOTIFY'))).toEqual([]);
  });

  it('setActionResult publishes trace and approvals; addApprovalEvent publishes audit', async () => {
    const result = fakePool(() => [{ conversation_id: C }]);
    await new PgAgentStore(result.pool).setActionResult('a1', { ok: true });
    expect(result.calls).toEqual(['BEGIN', 'UPDATE actions SET', notice('trace'), notice('approvals'), 'COMMIT']);
    const audit = fakePool(() => [eventRow]);
    await new PgAgentStore(audit.pool).addApprovalEvent({
      kind: 'auto_approved', runId: 'r1', conversationId: C, actorType: 'policy', toolName: 'issue_refund', toolArgs: {},
    });
    expect(audit.calls).toEqual(['BEGIN', 'INSERT INTO approval_events', notice('audit'), 'COMMIT']);
  });
});

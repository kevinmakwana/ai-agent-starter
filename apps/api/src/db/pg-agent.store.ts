import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../agent/errors';
import type {
  Action, ActionStatus, AgentStore, ApprovalEvent, Conversation, DecisionAudit, NewAction, NewApprovalEvent, NewStep, Run, RunMeta, Step,
} from '../agent/types';
import { AGENT_EVENTS_CHANNEL, type AgentEventKind, encodeEvent } from '../events/agent-events';
import type { ClaimedAction } from '../notify/types';
import { camel } from './pool';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const TERMINAL = ['completed', 'failed', 'step_limit'];

/** Satisfied by both Pool and PoolClient, so an event can be written inside or outside a transaction. */
type Db = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const MAX_EVENTS = 200;

/** A 'running' run with no step activity for this long is assumed to have died with its process. */
export const STALE_RUN_MS = 10 * 60_000;

export interface ConversationSummary extends Conversation {
  lastStatus: string | null;
  pendingApprovals: number;
  totalTokens: number;
}

export interface ApprovalView extends Action {
  customerName: string;
  customerEmail: string;
  userMessage: string | null;
  orderTotal: number | null;
  orderRefunded: number;
  /** The order's current status (a reviewer weighing a cancellation needs it); null when the action names no known order. */
  orderStatus: string | null;
  /** Why a human was needed, from the `requested` audit event. Null on approvals created before the log existed. */
  policyRule: string | null;
  policyDetail: Record<string, unknown> | null;
  /** Active reviewers who have approved so far, in order (reviewer-only; customers never see this). */
  approvedBy: string[];
  /** Their ids, parallel to `approvedBy`: names are not unique, so "have I approved this" must compare ids. */
  approvedByIds: string[];
  approvalsGiven: number;
}

export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool, private readonly staleRunMs = STALE_RUN_MS) {}

  private static readonly CONVERSATION = `
    SELECT c.id, c.customer_id, c.title, c.created_at, cu.name AS customer_name, cu.email AS customer_email
    FROM conversations c JOIN customers cu ON cu.id = c.customer_id`;

  /** Runs `work` in one transaction on its own connection. */
  private async inTx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Postgres delivers a NOTIFY only when its transaction commits, so a signal never outruns (or outlives) its write. */
  private async publish(db: Db, conversationId: string, ...kinds: AgentEventKind[]): Promise<void> {
    for (const kind of kinds) await db.query('SELECT pg_notify($1, $2)', [AGENT_EVENTS_CHANNEL, encodeEvent(kind, conversationId)]);
  }

  /** The returned accessToken is the only credential for this conversation; only its hash is stored. */
  async createConversation(customerId: number, title: string): Promise<Conversation & { accessToken: string }> {
    const accessToken = randomBytes(24).toString('base64url');
    const { rows } = await this.pool.query(
      'INSERT INTO conversations (customer_id, title, access_token_hash) VALUES ($1, $2, $3) RETURNING id',
      [customerId, title, hashToken(accessToken)],
    );
    return { ...(await this.getConversation(rows[0].id))!, accessToken };
  }

  async verifyConversationToken(id: string, token: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM conversations WHERE id = $1 AND access_token_hash = $2', [id, hashToken(token)]);
    return (rowCount ?? 0) > 0;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(`${PgAgentStore.CONVERSATION} WHERE c.id = $1`, [id]);
    return rows[0] ? camel<Conversation>(rows[0]) : null;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const { rows } = await this.pool.query(`
      SELECT c.id, c.customer_id, c.title, c.created_at, cu.name AS customer_name, cu.email AS customer_email,
        (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS last_status,
        (SELECT count(*)::int FROM actions a WHERE a.conversation_id = c.id AND a.status = 'pending_approval') AS pending_approvals,
        (SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::int FROM steps s WHERE s.conversation_id = c.id) AS total_tokens
      FROM conversations c JOIN customers cu ON cu.id = c.customer_id
      ORDER BY c.created_at DESC LIMIT 100`);
    return rows.map((r) => camel<ConversationSummary>(r));
  }

  async hasPendingApproval(conversationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM actions WHERE conversation_id = $1 AND status = 'pending_approval' LIMIT 1", [conversationId]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * One active run per conversation. A short transaction under a per-conversation advisory lock makes
   * check-then-insert atomic without holding a connection (or the lock) for the length of the run.
   */
  async createRun(conversationId: string, meta: Partial<RunMeta> = {}): Promise<Run> {
    return this.inTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [conversationId]);
      await db.query(
        `UPDATE runs r SET status = 'failed', error = 'Abandoned: the process died mid-run', finished_at = now()
         WHERE r.conversation_id = $1 AND r.status = 'running'
           AND r.created_at < now() - $2::double precision * interval '1 millisecond'
           AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = r.id
                           AND s.created_at > now() - $2::double precision * interval '1 millisecond')`,
        [conversationId, this.staleRunMs],
      );
      const busy = await db.query(
        "SELECT 1 FROM runs WHERE conversation_id = $1 AND status IN ('running', 'awaiting_approval') LIMIT 1",
        [conversationId],
      );
      if (busy.rowCount) throw new ConflictError('This conversation already has a run in progress or waiting for approval.');
      const { rows } = await db.query(
        "INSERT INTO runs (conversation_id, status, provider, model, prompt_version) VALUES ($1, 'running', $2, $3, $4) RETURNING *",
        [conversationId, meta.provider ?? null, meta.model ?? null, meta.promptVersion ?? null],
      );
      await this.publish(db, conversationId, 'trace');
      return camel<Run>(rows[0]);
    });
  }

  async getRun(id: string): Promise<Run | null> {
    const { rows } = await this.pool.query('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? camel<Run>(rows[0]) : null;
  }

  async updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'modelCalls' | 'error'>>): Promise<Run> {
    return this.inTx(async (db) => {
      const { rows } = await db.query(
        `UPDATE runs SET
           status = COALESCE($2, status),
           model_calls = COALESCE($3, model_calls),
           error = COALESCE($4, error),
           finished_at = CASE WHEN $2 = ANY($5::text[]) THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE finished_at END
         WHERE id = $1 RETURNING *`,
        [id, patch.status ?? null, patch.modelCalls ?? null, patch.error ?? null, TERMINAL],
      );
      const run = camel<Run>(rows[0]);
      await this.publish(db, run.conversationId, 'trace');
      return run;
    });
  }

  async addStep(s: NewStep): Promise<Step> {
    return this.inTx(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO steps (run_id, conversation_id, role, content, tool_name, tool_args, tool_call_id, result, latency_ms, input_tokens, output_tokens, cached_input_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [s.runId, s.conversationId, s.role, s.content ?? null, s.toolName ?? null,
         s.toolArgs === undefined ? null : JSON.stringify(s.toolArgs), s.toolCallId ?? null,
         s.result === undefined ? null : JSON.stringify(s.result), s.latencyMs ?? null, s.inputTokens ?? null, s.outputTokens ?? null, s.cachedInputTokens ?? null],
      );
      await this.publish(db, s.conversationId, 'trace');
      return camel<Step>(rows[0]);
    });
  }

  async conversationUsage(conversationId: string): Promise<{ inputTokens: number; outputTokens: number }> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(input_tokens), 0)::int AS "inputTokens", COALESCE(SUM(output_tokens), 0)::int AS "outputTokens"
       FROM steps WHERE conversation_id = $1`,
      [conversationId],
    );
    return rows[0];
  }

  async listSteps(conversationId: string): Promise<Step[]> {
    const { rows } = await this.pool.query('SELECT * FROM steps WHERE conversation_id = $1 ORDER BY id', [conversationId]);
    return rows.map((r) => camel<Step>(r));
  }

  async listRuns(conversationId: string): Promise<Run[]> {
    const { rows } = await this.pool.query('SELECT * FROM runs WHERE conversation_id = $1 ORDER BY created_at, id', [conversationId]);
    return rows.map((r) => camel<Run>(r));
  }

  async createAction(a: NewAction): Promise<Action> {
    return this.inTx(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO actions (run_id, conversation_id, tool_name, tool_args, tool_call_id, reasoning, approvals_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [a.runId, a.conversationId, a.toolName, JSON.stringify(a.toolArgs), a.toolCallId, a.reasoning, a.approvalsRequired ?? 1],
      );
      const action = camel<Action>(rows[0]);
      await this.insertEvent(db, {
        kind: 'requested', actionId: action.id, runId: a.runId, conversationId: a.conversationId, actorType: 'policy',
        toolName: a.toolName, toolArgs: a.toolArgs, rule: a.policy?.rule, detail: a.policy?.detail,
      });
      await this.publish(db, a.conversationId, 'trace', 'approvals');
      return action;
    });
  }

  async getAction(id: string): Promise<Action | null> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE id = $1', [id]);
    return rows[0] ? camel<Action>(rows[0]) : null;
  }

  async decideAction(
    id: string, status: 'approved' | 'rejected', note?: string,
    audit: DecisionAudit = { kind: status, actorType: 'reviewer' },
  ): Promise<Action | null> {
    return this.inTx(async (db) => {
      const { rows } = await db.query(
        `UPDATE actions SET status = $2, decision_note = $3, decided_at = now()
         WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [id, status, note ?? null],
      );
      if (!rows[0]) return null;
      const action = camel<Action>(rows[0]);
      await this.insertEvent(db, {
        kind: audit.kind, actionId: id, runId: action.runId, conversationId: action.conversationId, actorType: audit.actorType,
        actorId: audit.actorId, toolName: action.toolName, toolArgs: action.toolArgs, note,
      });
      await this.publish(db, action.conversationId, 'trace', 'approvals');
      return action;
    });
  }

  async approveStep(actionId: string, reviewer: { id: string }, note?: string): Promise<{ action: Action; final: boolean } | null> {
    return this.inTx(async (db) => {
      // The row lock serializes every approval of this action: only the transaction that reaches the count executes,
      // and one reviewer's concurrent requests cannot each see "no approval yet".
      const { rows } = await db.query('SELECT * FROM actions WHERE id = $1 FOR UPDATE', [actionId]);
      if (!rows[0] || rows[0].status !== 'pending_approval') return null;
      const action = camel<Action>(rows[0]);
      const counted = async () => (await db.query(
        `SELECT count(*)::int AS n FROM action_approvals aa JOIN reviewers r ON r.id = aa.reviewer_id
          WHERE aa.action_id = $1 AND r.active`, [actionId],
      )).rows[0].n as number;

      const { rowCount } = await db.query(
        'INSERT INTO action_approvals (action_id, reviewer_id, note) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [actionId, reviewer.id, note ?? null],
      );
      const given = await counted();
      // A repeat is only a retry once the requirement is already met (the action was reopened after a failed execution).
      if (rowCount === 0 && given < action.approvalsRequired) throw new ConflictError('You have already approved this', 'ALREADY_APPROVED_BY_YOU');

      const base = {
        actionId, runId: action.runId, conversationId: action.conversationId, actorType: 'reviewer' as const, actorId: reviewer.id,
        toolName: action.toolName, toolArgs: action.toolArgs, note,
      };
      if (given < action.approvalsRequired) {
        await this.insertEvent(db, { ...base, kind: 'first_approval', detail: { given, required: action.approvalsRequired } });
        await this.publish(db, action.conversationId, 'trace', 'approvals');
        return { action, final: false };
      }
      const { rows: done } = await db.query(
        `UPDATE actions SET status = 'approved', decision_note = $2, decided_at = now() WHERE id = $1 RETURNING *`, [actionId, note ?? null],
      );
      await this.insertEvent(db, { ...base, kind: 'approved' });
      await this.publish(db, action.conversationId, 'trace', 'approvals');
      return { action: camel<Action>(done[0]), final: true };
    });
  }

  private async insertEvent(db: Db, e: NewApprovalEvent): Promise<ApprovalEvent> {
    const { rows } = await db.query(
      `INSERT INTO approval_events (kind, action_id, run_id, conversation_id, actor_type, actor_id, tool_name, tool_args, rule, detail, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [e.kind, e.actionId ?? null, e.runId, e.conversationId, e.actorType, e.actorId ?? null, e.toolName,
       JSON.stringify(e.toolArgs), e.rule ?? null, e.detail ? JSON.stringify(e.detail) : null, e.note ?? null],
    );
    await this.publish(db, e.conversationId, 'audit');
    return { ...camel<ApprovalEvent>(rows[0]), actorName: null }; // names are joined when listing, not when writing
  }

  addApprovalEvent(e: NewApprovalEvent): Promise<ApprovalEvent> {
    return this.inTx((db) => this.insertEvent(db, e));
  }

  async listApprovalEvents(filter: { conversationId?: string; limit?: number; before?: number } = {}): Promise<ApprovalEvent[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_EVENTS);
    const { rows } = await this.pool.query(
      `SELECT e.*, r.name AS actor_name FROM approval_events e
       LEFT JOIN reviewers r ON r.id::text = e.actor_id
       WHERE ($1::uuid IS NULL OR e.conversation_id = $1) AND ($2::bigint IS NULL OR e.id < $2)
       ORDER BY e.id DESC LIMIT $3`,
      [filter.conversationId ?? null, filter.before ?? null, limit],
    );
    return rows.map((r) => camel<ApprovalEvent>(r));
  }

  async listPendingActionsOlderThan(cutoff: Date): Promise<Action[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM actions WHERE status = 'pending_approval' AND created_at < $1 ORDER BY created_at LIMIT 100",
      [cutoff],
    );
    return rows.map((r) => camel<Action>(r));
  }

  async listStrandedActions(decidedBefore: Date): Promise<Action[]> {
    const { rows } = await this.pool.query(
      `SELECT a.* FROM actions a JOIN runs r ON r.id = a.run_id
       WHERE a.status <> 'pending_approval' AND a.result IS NULL AND a.decided_at < $1 AND r.status = 'awaiting_approval'
       ORDER BY a.decided_at LIMIT 100`,
      [decidedBefore],
    );
    return rows.map((r) => camel<Action>(r));
  }

  async reopenAction(id: string): Promise<void> {
    await this.inTx(async (db) => {
      const { rows } = await db.query(
        `UPDATE actions SET status = 'pending_approval', decision_note = NULL, decided_at = NULL
         WHERE id = $1 AND status <> 'pending_approval' AND result IS NULL RETURNING conversation_id`,
        [id],
      );
      if (rows[0]) await this.publish(db, rows[0].conversation_id, 'trace', 'approvals');
    });
  }

  async setActionResult(id: string, result: unknown): Promise<void> {
    await this.inTx(async (db) => {
      const { rows } = await db.query('UPDATE actions SET result = $2 WHERE id = $1 RETURNING conversation_id', [id, JSON.stringify(result)]);
      if (rows[0]) await this.publish(db, rows[0].conversation_id, 'trace', 'approvals');
    });
  }

  /**
   * Marks up to `limit` pending, not-yet-announced actions as announced and returns them, oldest first. One statement:
   * `SKIP LOCKED` lets concurrent replicas claim disjoint rows, and the claim commits before any delivery (at most once).
   * Sends no change signal: a notified_at change is not something a viewer needs to see.
   */
  async claimUnnotified(limit: number): Promise<ClaimedAction[]> {
    const { rows } = await this.pool.query(
      `WITH picked AS (
         SELECT id FROM actions WHERE status = 'pending_approval' AND notified_at IS NULL
         ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE actions a SET notified_at = now() FROM picked p WHERE a.id = p.id
         RETURNING a.id, a.tool_name, a.tool_args, a.created_at
       )
       SELECT c.id, c.tool_name, c.tool_args, c.created_at,
              (SELECT e.rule FROM approval_events e WHERE e.action_id = c.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS rule
       FROM claimed c ORDER BY c.created_at, c.id`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id, toolName: r.tool_name, toolArgs: r.tool_args, createdAt: new Date(r.created_at).toISOString(), rule: r.rule ?? null,
    }));
  }

  /** Undoes a claim for rows whose notification was never started, so they are announced later. Decided rows are left alone. */
  async releaseClaims(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      "UPDATE actions SET notified_at = NULL WHERE id = ANY($1::uuid[]) AND status = 'pending_approval'", [ids]);
  }

  async listActions(status?: ActionStatus): Promise<Action[]> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC', [status ?? null]);
    return rows.map((r) => camel<Action>(r));
  }

  /** Approvals enriched with what a reviewer needs: who asked, what they said, and the order's money position.
   * The `orders` join (and so `orderStatus`) relies on the preflight ownership check (`loadOwnedOrder`): an action only
   * exists for an order the caller owns, so customers see these fields for their own orders only. Any new risky tool must
   * also preflight ownership.
   */
  async listApprovals(filter: { status?: ActionStatus; conversationId?: string } = {}): Promise<ApprovalView[]> {
    const { rows } = await this.pool.query(
      `SELECT a.*, cu.name AS customer_name, cu.email AS customer_email,
         (SELECT content FROM steps s WHERE s.run_id = a.run_id AND s.role = 'user' ORDER BY s.id LIMIT 1) AS user_message,
         o.total AS order_total, o.status AS order_status,
         COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.order_id = o.id), 0) AS order_refunded,
         (SELECT e.rule FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_rule,
         (SELECT e.detail FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_detail,
         COALESCE((SELECT array_agg(r.name ORDER BY aa.created_at, r.id) FROM action_approvals aa JOIN reviewers r ON r.id = aa.reviewer_id
                    WHERE aa.action_id = a.id AND r.active), '{}') AS approved_by,
         COALESCE((SELECT array_agg(r.id ORDER BY aa.created_at, r.id) FROM action_approvals aa JOIN reviewers r ON r.id = aa.reviewer_id
                    WHERE aa.action_id = a.id AND r.active), '{}') AS approved_by_ids
       FROM actions a
       JOIN conversations c ON c.id = a.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN orders o ON o.id = (a.tool_args->>'orderId')::int
       WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.conversation_id = $2)
       ORDER BY a.created_at DESC LIMIT 200`,
      [filter.status ?? null, filter.conversationId ?? null],
    );
    // only active reviewers count toward the rule, so only they are listed
    return rows.map((r) => ({ ...camel<ApprovalView>(r), approvalsGiven: r.approved_by.length }));
  }
}

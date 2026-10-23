import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { ConflictError } from '../agent/errors';
import type {
  Action, ActionStatus, AgentStore, ApprovalEvent, Conversation, DecisionAudit, NewAction, NewApprovalEvent, NewStep, Run, RunMeta, Step,
} from '../agent/types';
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
  /** Why a human was needed, from the `requested` audit event. Null on approvals created before the log existed. */
  policyRule: string | null;
  policyDetail: Record<string, unknown> | null;
}

export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool, private readonly staleRunMs = STALE_RUN_MS) {}

  private static readonly CONVERSATION = `
    SELECT c.id, c.customer_id, c.title, c.created_at, cu.name AS customer_name, cu.email AS customer_email
    FROM conversations c JOIN customers cu ON cu.id = c.customer_id`;

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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [conversationId]);
      await client.query(
        `UPDATE runs r SET status = 'failed', error = 'Abandoned: the process died mid-run', finished_at = now()
         WHERE r.conversation_id = $1 AND r.status = 'running'
           AND r.created_at < now() - $2::double precision * interval '1 millisecond'
           AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.run_id = r.id
                           AND s.created_at > now() - $2::double precision * interval '1 millisecond')`,
        [conversationId, this.staleRunMs],
      );
      const busy = await client.query(
        "SELECT 1 FROM runs WHERE conversation_id = $1 AND status IN ('running', 'awaiting_approval') LIMIT 1",
        [conversationId],
      );
      if (busy.rowCount) throw new ConflictError('This conversation already has a run in progress or waiting for approval.');
      const { rows } = await client.query(
        "INSERT INTO runs (conversation_id, status, provider, model, prompt_version) VALUES ($1, 'running', $2, $3, $4) RETURNING *",
        [conversationId, meta.provider ?? null, meta.model ?? null, meta.promptVersion ?? null],
      );
      await client.query('COMMIT');
      return camel<Run>(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getRun(id: string): Promise<Run | null> {
    const { rows } = await this.pool.query('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? camel<Run>(rows[0]) : null;
  }

  async updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'modelCalls' | 'error'>>): Promise<Run> {
    const { rows } = await this.pool.query(
      `UPDATE runs SET
         status = COALESCE($2, status),
         model_calls = COALESCE($3, model_calls),
         error = COALESCE($4, error),
         finished_at = CASE WHEN $2 = ANY($5::text[]) THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE finished_at END
       WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.modelCalls ?? null, patch.error ?? null, TERMINAL],
    );
    return camel<Run>(rows[0]);
  }

  async addStep(s: NewStep): Promise<Step> {
    const { rows } = await this.pool.query(
      `INSERT INTO steps (run_id, conversation_id, role, content, tool_name, tool_args, tool_call_id, result, latency_ms, input_tokens, output_tokens, cached_input_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [s.runId, s.conversationId, s.role, s.content ?? null, s.toolName ?? null,
       s.toolArgs === undefined ? null : JSON.stringify(s.toolArgs), s.toolCallId ?? null,
       s.result === undefined ? null : JSON.stringify(s.result), s.latencyMs ?? null, s.inputTokens ?? null, s.outputTokens ?? null, s.cachedInputTokens ?? null],
    );
    return camel<Step>(rows[0]);
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO actions (run_id, conversation_id, tool_name, tool_args, tool_call_id, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [a.runId, a.conversationId, a.toolName, JSON.stringify(a.toolArgs), a.toolCallId, a.reasoning],
      );
      const action = camel<Action>(rows[0]);
      await this.insertEvent(client, {
        kind: 'requested', actionId: action.id, runId: a.runId, conversationId: a.conversationId, actorType: 'policy',
        toolName: a.toolName, toolArgs: a.toolArgs, rule: a.policy?.rule, detail: a.policy?.detail,
      });
      await client.query('COMMIT');
      return action;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getAction(id: string): Promise<Action | null> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE id = $1', [id]);
    return rows[0] ? camel<Action>(rows[0]) : null;
  }

  async decideAction(
    id: string, status: 'approved' | 'rejected', note?: string,
    audit: DecisionAudit = { kind: status, actorType: 'reviewer' },
  ): Promise<Action | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE actions SET status = $2, decision_note = $3, decided_at = now()
         WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [id, status, note ?? null],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const action = camel<Action>(rows[0]);
      await this.insertEvent(client, {
        kind: audit.kind, actionId: id, runId: action.runId, conversationId: action.conversationId, actorType: audit.actorType,
        toolName: action.toolName, toolArgs: action.toolArgs, note,
      });
      await client.query('COMMIT');
      return action;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async insertEvent(db: Db, e: NewApprovalEvent): Promise<ApprovalEvent> {
    const { rows } = await db.query(
      `INSERT INTO approval_events (kind, action_id, run_id, conversation_id, actor_type, actor_id, tool_name, tool_args, rule, detail, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [e.kind, e.actionId ?? null, e.runId, e.conversationId, e.actorType, e.actorId ?? null, e.toolName,
       JSON.stringify(e.toolArgs), e.rule ?? null, e.detail ? JSON.stringify(e.detail) : null, e.note ?? null],
    );
    return camel<ApprovalEvent>(rows[0]);
  }

  addApprovalEvent(e: NewApprovalEvent): Promise<ApprovalEvent> {
    return this.insertEvent(this.pool, e);
  }

  async listApprovalEvents(filter: { conversationId?: string; limit?: number; before?: number } = {}): Promise<ApprovalEvent[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_EVENTS);
    const { rows } = await this.pool.query(
      `SELECT * FROM approval_events
       WHERE ($1::uuid IS NULL OR conversation_id = $1) AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3`,
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
    await this.pool.query(
      `UPDATE actions SET status = 'pending_approval', decision_note = NULL, decided_at = NULL
       WHERE id = $1 AND status <> 'pending_approval' AND result IS NULL`,
      [id],
    );
  }

  async setActionResult(id: string, result: unknown): Promise<void> {
    await this.pool.query('UPDATE actions SET result = $2 WHERE id = $1', [id, JSON.stringify(result)]);
  }

  async listActions(status?: ActionStatus): Promise<Action[]> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC', [status ?? null]);
    return rows.map((r) => camel<Action>(r));
  }

  /** Approvals enriched with what a reviewer needs: who asked, what they said, and the order's money position. */
  async listApprovals(filter: { status?: ActionStatus; conversationId?: string } = {}): Promise<ApprovalView[]> {
    const { rows } = await this.pool.query(
      `SELECT a.*, cu.name AS customer_name, cu.email AS customer_email,
         (SELECT content FROM steps s WHERE s.run_id = a.run_id AND s.role = 'user' ORDER BY s.id LIMIT 1) AS user_message,
         o.total AS order_total,
         COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.order_id = o.id), 0) AS order_refunded,
         (SELECT e.rule FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_rule,
         (SELECT e.detail FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_detail
       FROM actions a
       JOIN conversations c ON c.id = a.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN orders o ON o.id = (a.tool_args->>'orderId')::int
       WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.conversation_id = $2)
       ORDER BY a.created_at DESC LIMIT 200`,
      [filter.status ?? null, filter.conversationId ?? null],
    );
    return rows.map((r) => camel<ApprovalView>(r));
  }
}

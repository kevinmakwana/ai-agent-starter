import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Action, ActionStatus, AgentStore, Conversation, NewAction, NewStep, Run, Step } from '../agent/types';
import { camel } from './pool';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const TERMINAL = ['completed', 'failed', 'step_limit'];

export interface ConversationSummary extends Conversation {
  lastStatus: string | null;
  pendingApprovals: number;
}

export interface ApprovalView extends Action {
  customerName: string;
  customerEmail: string;
  userMessage: string | null;
  orderTotal: number | null;
  orderRefunded: number;
}

export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

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
        (SELECT count(*)::int FROM actions a WHERE a.conversation_id = c.id AND a.status = 'pending_approval') AS pending_approvals
      FROM conversations c JOIN customers cu ON cu.id = c.customer_id
      ORDER BY c.created_at DESC LIMIT 100`);
    return rows.map((r) => camel<ConversationSummary>(r));
  }

  async hasPendingApproval(conversationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM actions WHERE conversation_id = $1 AND status = 'pending_approval' LIMIT 1", [conversationId]);
    return (rowCount ?? 0) > 0;
  }

  async createRun(conversationId: string): Promise<Run> {
    const { rows } = await this.pool.query("INSERT INTO runs (conversation_id, status) VALUES ($1, 'running') RETURNING *", [conversationId]);
    return camel<Run>(rows[0]);
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
      `INSERT INTO steps (run_id, conversation_id, role, content, tool_name, tool_args, tool_call_id, result, latency_ms, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [s.runId, s.conversationId, s.role, s.content ?? null, s.toolName ?? null,
       s.toolArgs === undefined ? null : JSON.stringify(s.toolArgs), s.toolCallId ?? null,
       s.result === undefined ? null : JSON.stringify(s.result), s.latencyMs ?? null, s.inputTokens ?? null, s.outputTokens ?? null],
    );
    return camel<Step>(rows[0]);
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
    const { rows } = await this.pool.query(
      `INSERT INTO actions (run_id, conversation_id, tool_name, tool_args, tool_call_id, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [a.runId, a.conversationId, a.toolName, JSON.stringify(a.toolArgs), a.toolCallId, a.reasoning],
    );
    return camel<Action>(rows[0]);
  }

  async getAction(id: string): Promise<Action | null> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE id = $1', [id]);
    return rows[0] ? camel<Action>(rows[0]) : null;
  }

  async decideAction(id: string, status: 'approved' | 'rejected', note?: string): Promise<Action | null> {
    const { rows } = await this.pool.query(
      `UPDATE actions SET status = $2, decision_note = $3, decided_at = now()
       WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
      [id, status, note ?? null],
    );
    return rows[0] ? camel<Action>(rows[0]) : null;
  }

  async setActionResult(id: string, result: unknown): Promise<void> {
    await this.pool.query('UPDATE actions SET result = $2 WHERE id = $1', [id, JSON.stringify(result)]);
  }

  async listActions(status?: ActionStatus): Promise<Action[]> {
    const { rows } = await this.pool.query('SELECT * FROM actions WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC', [status ?? null]);
    return rows.map((r) => camel<Action>(r));
  }

  /** Approvals enriched with what a reviewer needs: who asked, what they said, and the order's money position. */
  async listApprovals(status?: ActionStatus): Promise<ApprovalView[]> {
    const { rows } = await this.pool.query(
      `SELECT a.*, cu.name AS customer_name, cu.email AS customer_email,
         (SELECT content FROM steps s WHERE s.run_id = a.run_id AND s.role = 'user' ORDER BY s.id LIMIT 1) AS user_message,
         o.total AS order_total,
         COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.order_id = o.id), 0) AS order_refunded
       FROM actions a
       JOIN conversations c ON c.id = a.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN orders o ON o.id = (a.tool_args->>'orderId')::int
       WHERE ($1::text IS NULL OR a.status = $1)
       ORDER BY a.created_at DESC LIMIT 200`,
      [status ?? null],
    );
    return rows.map((r) => camel<ApprovalView>(r));
  }
}

import { Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { NotFoundError } from '../agent/errors';
import { AgentRunner } from '../agent/runner';
import type { Pool } from 'pg';
import { PgAgentStore } from '../db/pg-agent.store';
import { PgShopRepo } from '../db/pg-shop.repo';
import { PG_POOL } from '../tokens';
import { CreateConversationDto, SendMessageDto } from './dto';

@Controller()
export class ConversationsController {
  constructor(
    private readonly store: PgAgentStore,
    private readonly shop: PgShopRepo,
    private readonly runner: AgentRunner,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** Not in the brief, but the UI needs it to pick who a conversation is bound to. */
  @Get('customers')
  async customers() {
    const { rows } = await this.pool.query(`
      SELECT c.id, c.name, c.email, count(o.id)::int AS "orderCount", min(o.id) AS "firstOrderId"
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id`);
    return rows;
  }

  @Post('conversations')
  async create(@Body() dto: CreateConversationDto) {
    const customer = await this.shop.getCustomer(dto.customerId);
    if (!customer) throw new NotFoundError(`Customer ${dto.customerId} not found`);
    return this.store.createConversation(customer.id, dto.title ?? `Chat with ${customer.name}`);
  }

  @Get('conversations')
  list() {
    return this.store.listConversations();
  }

  /** Full trace: every run with every step, plus the approvals raised along the way. */
  @Get('conversations/:id')
  async trace(@Param('id', ParseUUIDPipe) id: string) {
    const conversation = await this.requireConversation(id);
    const [runs, steps, approvals] = await Promise.all([
      this.store.listRuns(id),
      this.store.listSteps(id),
      this.store.listApprovals(),
    ]);
    return {
      conversation,
      runs: runs.map((run) => ({ ...run, steps: steps.filter((s) => s.runId === run.id) })),
      approvals: approvals.filter((a) => a.conversationId === id),
    };
  }

  @Post('conversations/:id/messages')
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    const conv = await this.requireConversation(id);
    if (await this.store.hasPendingApproval(id)) {
      throw new ConflictException('This conversation is waiting for a human approval; resolve it before sending more messages.');
    }
    const run = await this.runner.handleUserMessage(conv, dto.content);
    const steps = (await this.store.listSteps(id)).filter((s) => s.runId === run.id);
    return { run: { ...run, steps } };
  }

  private async requireConversation(id: string) {
    const conv = await this.store.getConversation(id);
    if (!conv) throw new NotFoundError(`Conversation ${id} not found`);
    return conv;
  }
}

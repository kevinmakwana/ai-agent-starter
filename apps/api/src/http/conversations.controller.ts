import { Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { NotFoundError } from '../agent/errors';
import { AgentRunner } from '../agent/runner';
import type { Pool } from 'pg';
import { PgAgentStore } from '../db/pg-agent.store';
import { PgShopRepo } from '../db/pg-shop.repo';
import { APP_CONFIG, PG_POOL } from '../tokens';
import { ConversationAccessGuard } from './conversation-access.guard';
import { CreateConversationDto, SendMessageDto } from './dto';
import { limited } from './rate-limit';
import { forCaller, sumUsage } from './run-view';
import { isReviewer, ReviewerGuard } from './reviewer.guard';

@Controller()
export class ConversationsController {
  constructor(
    private readonly store: PgAgentStore,
    private readonly shop: PgShopRepo,
    private readonly runner: AgentRunner,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Not in the brief, but the UI needs it to pick who a conversation is bound to. */
  @Get('customers')
  @UseGuards(ReviewerGuard)
  async customers() {
    const { rows } = await this.pool.query(`
      SELECT c.id, c.name, c.email, count(o.id)::int AS "orderCount", min(o.id) AS "firstOrderId"
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id`);
    return rows;
  }

  /** Returns the conversation plus its one-time `accessToken`. Who may *start* one is still unauthenticated (see README). */
  @Post('conversations')
  @limited((l) => l.startPerMinute)
  async create(@Body() dto: CreateConversationDto) {
    const customer = dto.customerId
      ? await this.shop.getCustomer(dto.customerId)
      : await this.pool.query('SELECT id, name, email FROM customers WHERE lower(email) = lower($1)', [dto.email]).then((r) => r.rows[0]);
    if (!customer) throw new NotFoundError(`Customer ${dto.customerId ?? dto.email} not found`);
    return this.store.createConversation(customer.id, dto.title ?? `Chat with ${customer.name}`);
  }

  /** Reviewer-only: customers only ever see conversations they hold a token for. */
  @Get('conversations')
  @UseGuards(ReviewerGuard)
  list() {
    return this.store.listConversations();
  }

  /** Full trace: every run with every step, plus the approvals raised along the way. */
  @Get('conversations/:id')
  @UseGuards(ConversationAccessGuard)
  async trace(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const conversation = await this.requireConversation(id);
    const [runs, steps, approvals] = await Promise.all([
      this.store.listRuns(id),
      this.store.listSteps(id),
      this.store.listApprovals({ conversationId: id }),
    ]);
    return {
      conversation,
      runs: runs.map((run) => {
        const runSteps = steps.filter((s) => s.runId === run.id);
        return { ...forCaller(run, this.isReviewer(req)), usage: sumUsage(runSteps), steps: runSteps };
      }),
      usage: { ...sumUsage(steps), budget: this.cfg.conversationTokenBudget },
      approvals,
    };
  }

  @Post('conversations/:id/messages')
  @limited((l) => l.messagesPerMinute)
  @UseGuards(ConversationAccessGuard)
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto, @Req() req: Request) {
    const conv = await this.requireConversation(id);
    if (await this.store.hasPendingApproval(id)) {
      throw new ConflictException('This conversation is waiting for a human approval; resolve it before sending more messages.');
    }
    const run = await this.runner.handleUserMessage(conv, dto.content);
    const steps = (await this.store.listSteps(id)).filter((s) => s.runId === run.id);
    return { run: { ...forCaller(run, this.isReviewer(req)), usage: sumUsage(steps), steps } };
  }

  private isReviewer(req: Request) {
    return isReviewer(this.cfg.reviewerApiKey, req.headers.authorization);
  }

  private async requireConversation(id: string) {
    const conv = await this.store.getConversation(id);
    if (!conv) throw new NotFoundError(`Conversation ${id} not found`);
    return conv;
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { principalOf, reviewerOf } from '../auth/principal';
import { AgentRunner } from '../agent/runner';
import type { ActionStatus } from '../agent/types';
import { PgAgentStore } from '../db/pg-agent.store';
import { DecideApprovalDto, ListApprovalEventsQuery, ListApprovalsQuery } from './dto';
import { ReviewerGuard } from './reviewer.guard';

const STATUS: Record<string, ActionStatus | undefined> = {
  pending: 'pending_approval', approved: 'approved', rejected: 'rejected', all: undefined,
};

@Controller('approvals')
@UseGuards(ReviewerGuard)
export class ApprovalsController {
  constructor(private readonly store: PgAgentStore, private readonly runner: AgentRunner) {}

  @Get()
  list(@Query() q: ListApprovalsQuery) {
    return this.store.listApprovals({ status: STATUS[q.status ?? 'all'] });
  }

  /** The append-only audit log of approval decisions, newest first. */
  @Get('events')
  events(@Query() q: ListApprovalEventsQuery) {
    return this.store.listApprovalEvents(q);
  }

  /** Approve executes the parked tool call and resumes the run; reject tells the agent it was declined. */
  @Post(':id')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideApprovalDto, @Req() req: Request) {
    // A signed-in reviewer is named in the audit log; shared-key and demo callers have no identity (so no four-eyes vote).
    const me = reviewerOf(principalOf(req));
    const { action, run } = await this.runner.decide(id, dto.decision, dto.note, 'reviewer', me && { id: me.id, name: me.name });
    const steps = (await this.store.listSteps(action.conversationId)).filter((s) => s.runId === run.id);
    return { action, run: { ...run, steps } };
  }
}

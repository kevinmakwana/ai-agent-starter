import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AgentRunner } from '../agent/runner';
import type { ActionStatus } from '../agent/types';
import { PgAgentStore } from '../db/pg-agent.store';
import { DecideApprovalDto, ListApprovalsQuery } from './dto';

const STATUS: Record<string, ActionStatus | undefined> = {
  pending: 'pending_approval', approved: 'approved', rejected: 'rejected', all: undefined,
};

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly store: PgAgentStore, private readonly runner: AgentRunner) {}

  @Get()
  list(@Query() q: ListApprovalsQuery) {
    return this.store.listApprovals(STATUS[q.status ?? 'all']);
  }

  /** Approve executes the parked tool call and resumes the run; reject tells the agent it was declined. */
  @Post(':id')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideApprovalDto) {
    const { action, run } = await this.runner.decide(id, dto.decision, dto.note);
    const steps = (await this.store.listSteps(action.conversationId)).filter((s) => s.runId === run.id);
    return { action, run: { ...run, steps } };
  }
}

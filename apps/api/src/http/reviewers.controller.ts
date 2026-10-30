import { BadRequestException, Body, Controller, Get, Logger, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../agent/errors';
import { hashPassword } from '../auth/password';
import { principalOf, reviewerOf } from '../auth/principal';
import type { ReviewerPatch, ReviewerStore } from '../auth/reviewer.store';
import { REVIEWER_STORE } from '../auth/tokens';
import { AdminGuard } from './admin.guard';
import { CreateReviewerDto, UpdateReviewerDto } from './dto';
import { ReviewerGuard } from './reviewer.guard';

/** Admin-only reviewer management. Actions are logged (actor and target ids, never passwords). */
@Controller('reviewers')
@UseGuards(ReviewerGuard, AdminGuard)
export class ReviewersController {
  private readonly log = new Logger('Reviewers');

  constructor(@Inject(REVIEWER_STORE) private readonly store: ReviewerStore) {}

  @Get()
  list() {
    return this.store.listReviewers();
  }

  @Post()
  async create(@Body() dto: CreateReviewerDto, @Req() req: Request) {
    const passwordHash = await this.hash(dto.password);
    const created = await this.store.createReviewer({ email: dto.email, name: dto.name, role: dto.role, passwordHash });
    this.log.log(`admin ${this.actor(req)} created reviewer ${created.id} (${created.role})`);
    return created;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReviewerDto, @Req() req: Request) {
    const patch: ReviewerPatch = { name: dto.name, role: dto.role, active: dto.active };
    if (dto.password !== undefined) patch.passwordHash = await this.hash(dto.password);
    const updated = await this.store.updateReviewer(id, patch);
    if (!updated) throw new NotFoundError(`Reviewer ${id} not found`);
    const changed = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
    this.log.log(`admin ${this.actor(req)} changed reviewer ${id}: ${changed.join(', ') || 'nothing'}`);
    return updated;
  }

  private actor(req: Request) {
    return reviewerOf(principalOf(req))?.id ?? 'unknown';
  }

  private async hash(plain: string) {
    try {
      return await hashPassword(plain);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Invalid password');
    }
  }
}

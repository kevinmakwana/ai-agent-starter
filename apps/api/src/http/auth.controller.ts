import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { readCookie, SESSION_COOKIE, sessionCookieOptions } from '../auth/cookie';
import { principalOf, reviewerOf } from '../auth/principal';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { ChangePasswordDto, LoginDto } from './dto';
import { limitedLogin } from './rate-limit';
import { ReviewerGuard } from './reviewer.guard';
import { REVIEWER_STORE } from '../auth/tokens';
import type { ReviewerStore } from '../auth/reviewer.store';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(REVIEWER_STORE) private readonly store: ReviewerStore,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Sets the session cookie. Every failure is the same 401, whatever the cause. */
  @Post('login')
  @HttpCode(200)
  @limitedLogin()
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, reviewer } = await this.auth.login(dto.email, dto.password);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(this.cfg.auth));
    return { reviewer };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(ReviewerGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.auth.logout(token);
    // same attributes as when it was set, so the browser matches and removes it
    const { maxAge: _maxAge, ...attrs } = sessionCookieOptions(this.cfg.auth);
    res.clearCookie(SESSION_COOKIE, attrs);
  }

  @Get('me')
  async me(@Req() req: Request) {
    const me = reviewerOf(principalOf(req));
    const reviewer = me && (await this.store.findById(me.id));
    if (!reviewer) throw new UnauthorizedException('Not signed in');
    return { reviewer };
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(ReviewerGuard)
  async password(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const me = reviewerOf(principalOf(req));
    const token = readCookie(req, SESSION_COOKIE);
    if (!me || !token) throw new UnauthorizedException('Sign in to change your password');
    await this.auth.changePassword(me.id, dto.current, dto.next, token);
  }
}

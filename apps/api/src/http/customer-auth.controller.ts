import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CustomerAuthService } from '../auth/customer-auth.service';
import { CUSTOMER_COOKIE, customerCookieOptions, readCookie } from '../auth/cookie';
import { customerOf, principalOf } from '../auth/principal';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { CsrfHeaderGuard } from './csrf-header.guard';
import { CustomerGuard } from './customer.guard';
import { RequestLinkDto, VerifyLinkDto } from './dto';
import { LoginEnabledGuard } from './login-enabled.guard';
import { limitedCustomerLogin } from './rate-limit';

@Controller('customer-auth')
@UseGuards(LoginEnabledGuard, CsrfHeaderGuard)
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Always the same answer; mail goes out afterwards, and only to a real customer. */
  @Post('request')
  @HttpCode(202)
  @limitedCustomerLogin()
  async request(@Body() dto: RequestLinkDto) {
    await this.auth.requestLink(dto.email);
    return { status: 'sent' };
  }

  /** The link's token is redeemed here (not by a GET), so a mail scanner that merely fetches the page consumes nothing. */
  @Post('verify')
  @HttpCode(200)
  @limitedCustomerLogin()
  async verify(@Body() dto: VerifyLinkDto, @Res({ passthrough: true }) res: Response) {
    const { token, customer } = await this.auth.verify(dto.token);
    res.cookie(CUSTOMER_COOKIE, token, customerCookieOptions(this.cfg));
    return { customer };
  }

  @Get('me')
  @UseGuards(CustomerGuard)
  me(@Req() req: Request) {
    const { customerId, name, email } = customerOf(principalOf(req))!; // CustomerGuard guarantees a customer
    return { customer: { id: customerId, name, email } };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CustomerGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, CUSTOMER_COOKIE);
    if (token) await this.auth.logout(token);
    this.clear(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(CustomerGuard)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(customerOf(principalOf(req))!.customerId);
    this.clear(res);
  }

  private clear(res: Response) {
    const { maxAge: _maxAge, ...attrs } = customerCookieOptions(this.cfg); // same attributes as when it was set, so the browser matches it
    res.clearCookie(CUSTOMER_COOKIE, attrs);
  }
}

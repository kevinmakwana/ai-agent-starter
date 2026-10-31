import { type CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

/** The customer-auth routes exist only in login mode; otherwise they are as absent as before this feature. */
@Injectable()
export class LoginEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(): boolean {
    if (!this.cfg.customerLogin.enabled) throw new NotFoundException();
    return true;
  }
}

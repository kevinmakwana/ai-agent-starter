import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CustomerAuthService } from './customer-auth.service';

/** Runs before every route so guards, controllers and SSE streams all read the same `req.principal`. */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService, private readonly customers: CustomerAuthService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    let principal = await this.auth.resolvePrincipal(req);
    // A reviewer (cookie or shared key) wins. An anonymous caller, or the open demo, gives way to a valid customer session.
    if (this.customers.enabled && (principal.kind === 'none' || principal.kind === 'demo')) {
      const customer = await this.customers.resolve(req).catch(() => null); // fail closed
      if (customer) principal = { kind: 'customer', customerId: customer.id, email: customer.email, name: customer.name };
    }
    req.principal = principal;
    next();
  }
}

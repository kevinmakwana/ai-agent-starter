import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './auth.service';

/** Runs before every route so guards, controllers and SSE streams all read the same `req.principal`. */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    req.principal = await this.auth.resolvePrincipal(req);
    next();
  }
}

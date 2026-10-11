import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ConflictError, NotFoundError, UpstreamLlmError } from '../agent/errors';

/** Maps framework-free domain errors to HTTP. Upstream LLM failures become 502 with a clear message. */
@Catch(NotFoundError, ConflictError, UpstreamLlmError)
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Upstream');

  catch(err: Error, host: ArgumentsHost) {
    const [statusCode, error] =
      err instanceof NotFoundError ? [HttpStatus.NOT_FOUND, 'Not Found']
      : err instanceof ConflictError ? [HttpStatus.CONFLICT, 'Conflict']
      : [HttpStatus.BAD_GATEWAY, 'Bad Gateway'];
    if (err instanceof UpstreamLlmError && err.detail) this.logger.error(`${err.message} :: ${err.detail}`);
    host.switchToHttp().getResponse<Response>().status(statusCode).json({ statusCode, error, message: err.message });
  }
}

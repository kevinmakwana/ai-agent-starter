import { type INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

/** Shared by main.ts and the e2e suite so both run with identical validation, headers, CORS and proxy rules. */
export function configureApp(app: INestApplication): void {
  const cfg = app.get<AppConfig>(APP_CONFIG);

  app.use(helmet());
  // Browsers reach the API through the same-origin Next.js proxy, so CORS stays off unless origins are listed.
  if (cfg.corsOrigins.length) {
    app.enableCors({
      origin: cfg.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['content-type', 'authorization', 'x-conversation-token'],
    });
  }
  // Rate limits key on req.ip, which only follows X-Forwarded-For for proxies we are told to trust.
  if (cfg.trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', cfg.trustProxy);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

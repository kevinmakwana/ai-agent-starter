import { type INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared by main.ts and the e2e suite so both run with identical validation rules. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

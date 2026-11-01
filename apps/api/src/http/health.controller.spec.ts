import { ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { AuthService } from '../auth/auth.service';
import { loadConfig } from '../config';
import { HealthController } from './health.controller';

const build = (dbUp: boolean) => {
  const query = jest.fn(async () => {
    if (!dbUp) throw new Error('connection refused postgres://user:secret@db/x');
    return { rows: [] };
  });
  const auth = { isAccountsMode: jest.fn(async () => false) };
  const controller = new HealthController({ query } as unknown as Pool, loadConfig({}), auth as unknown as AuthService);
  return { controller, query, auth };
};

describe('HealthController', () => {
  describe('with the database up', () => {
    it('is live, ready and fully described', async () => {
      const { controller } = build(true);
      expect(controller.live()).toEqual({ status: 'ok' });
      expect(await controller.ready()).toEqual({ status: 'ok', db: 'up' });
      expect(await controller.check()).toEqual({
        status: 'ok',
        db: 'up',
        provider: 'mock',
        reviewerAuth: false,
        reviewerAccounts: false,
        customerLogin: false,
      });
    });
  });

  describe('with the database down', () => {
    it('stays live, because restarting the process would not fix the database', async () => {
      const { controller, query } = build(false);
      expect(controller.live()).toEqual({ status: 'ok' });
      expect(query).not.toHaveBeenCalled();
    });

    it('is not ready, and neither is the combined endpoint', async () => {
      const { controller } = build(false);
      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('never puts the database error in the response', async () => {
      const { controller } = build(false);
      const err = (await controller.ready().catch((e: ServiceUnavailableException) => e)) as ServiceUnavailableException;
      expect(JSON.stringify(err.getResponse())).not.toContain('secret');
      expect(err.getResponse()).toEqual({ status: 'error', db: 'down', provider: 'mock' });
    });
  });
});

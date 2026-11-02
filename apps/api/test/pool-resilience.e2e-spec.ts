import { Logger } from '@nestjs/common';
import { createPool } from '../src/db/pool';

// Real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('database pool when Postgres drops a connection (e2e)', () => {
  it('survives the server killing an idle connection, logs it without secrets, and serves the next query', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const admin = createPool(process.env.E2E_DATABASE_URL!);
    const pool = createPool(process.env.E2E_DATABASE_URL!);
    try {
      // Leave one connection idle in the pool, then have the server terminate it (a restart or failover does the same).
      const client = await pool.connect();
      const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
      client.release();
      await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
      await new Promise((r) => setTimeout(r, 300));

      expect((await pool.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('idle database connection');
      expect(line).not.toContain(new URL(process.env.E2E_DATABASE_URL!).password || 'no-password-in-url');
    } finally {
      await pool.end();
      await admin.end();
      jest.restoreAllMocks();
    }
  });
});

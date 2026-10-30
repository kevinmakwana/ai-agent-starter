import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ConflictError } from '../agent/errors';
import { hashPassword } from '../auth/password';
import { PgReviewerStore } from '../auth/pg-reviewer.store';
import { loadConfig, loadRootEnv } from '../config';
import { createPool, ensureSchema } from '../db/pool';
import { parseReviewerAddArgs, resolvePassword } from './reviewer-add-args';

/** Reads one line from the terminal without echoing it. */
function promptHidden(label: string): Promise<string> {
  process.stdout.write(label);
  const rl = createInterface({ input: process.stdin, output: new Writable({ write: (_c, _e, done) => done() }), terminal: true });
  return new Promise((resolve) => rl.question('', (answer) => {
    rl.close();
    process.stdout.write('\n');
    resolve(answer);
  }));
}

async function readPassword(): Promise<string> {
  const fromEnv = resolvePassword(process.env);
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error('Set REVIEWER_PASSWORD, or run this in a terminal to be prompted for the password.');
  const first = await promptHidden('Password: ');
  if (first !== (await promptHidden('Repeat password: '))) throw new Error('The passwords do not match.');
  return first;
}

async function main() {
  loadRootEnv();
  const args = parseReviewerAddArgs(process.argv.slice(2));
  const passwordHash = await hashPassword(await readPassword());
  const pool = createPool(loadConfig().databaseUrl);
  try {
    await ensureSchema(pool);
    const created = await new PgReviewerStore(pool).createReviewer({ ...args, passwordHash });
    console.log(`Created ${created.role} ${created.email} (${created.id}).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof ConflictError ? `A reviewer with that email already exists.` : `Could not add the reviewer: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

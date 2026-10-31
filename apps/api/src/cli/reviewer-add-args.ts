import { MAX_PASSWORD, MIN_PASSWORD } from '../auth/password';
import type { ReviewerRole } from '../auth/reviewer.store';

export interface ReviewerAddArgs {
  email: string;
  name: string;
  role: ReviewerRole;
}

const PASSWORD_FLAGS = new Set(['--password', '--pass', '-p']);

/** Parses `--email`, `--name` and optional `--role` (`--flag value` or `--flag=value`). A password flag is refused. */
export function parseReviewerAddArgs(argv: string[]): ReviewerAddArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (PASSWORD_FLAGS.has(flag)) {
      throw new Error('Do not pass the password as a flag (it would end up in your shell history). Set REVIEWER_PASSWORD or type it at the prompt.');
    }
    if (flag !== '--email' && flag !== '--name' && flag !== '--role') throw new Error(`Unknown argument "${flag}"`);
    values[flag.slice(2)] = inline ?? argv[++i] ?? '';
  }
  const email = (values.email ?? '').trim().toLowerCase();
  const name = (values.name ?? '').trim();
  const role = values.role ?? 'admin';
  if (!email) throw new Error('--email is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error(`"${email}" is not a valid email address`);
  if (!name || name.length > 100) throw new Error('--name is required (1-100 characters)');
  if (role !== 'admin' && role !== 'reviewer') throw new Error('--role must be admin or reviewer');
  return { email, name, role };
}

/** The password from the environment (validated), or null when the caller should prompt for it. */
export function resolvePassword(env: NodeJS.ProcessEnv): string | null {
  const pw = env.REVIEWER_PASSWORD;
  if (!pw) return null;
  if (pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > MAX_PASSWORD) throw new Error(`Password must be at most ${MAX_PASSWORD} characters`);
  return pw;
}

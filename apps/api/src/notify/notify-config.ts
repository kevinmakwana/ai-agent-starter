export interface NotifyConfig {
  webhook?: { url: string; secret?: string };
  slack?: { url: string };
  email?: { smtpUrl: string; from: string; to: string[] };
  /** Link put in every message. */
  consoleUrl: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ADDRESS = /^[^\s@,<>"]+@[^\s@,<>"]+$/;
const DEFAULT_CONSOLE_URL = 'http://localhost:3000/reviewer';

/** Empty or whitespace-only counts as unset, so a copied .env.example with blank values stays valid. Values are trimmed. */
function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

// None of the errors below include the offending value: these URLs can carry secrets.

/** Parses `raw`, or returns null when it is not a URL or its protocol is not one of `protocols`. */
function parseUrl(raw: string, protocols: string[]): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return protocols.includes(url.protocol) ? url : null;
}

/** Node's fetch refuses a URL with credentials and echoes it in its error, and these URLs are logged or broadcast. */
const hasCredentials = (url: URL): boolean => url.username !== '' || url.password !== '';

/** https only; plain http is allowed for local hosts so a dev receiver works. */
function secureUrl(name: string, raw: string): string {
  const url = parseUrl(raw, ['https:', 'http:']);
  if (!url || (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`${name} must be an https URL (http is allowed only for localhost)`);
  }
  if (hasCredentials(url)) throw new Error(`${name} must not contain a username or password`);
  return raw;
}

function httpUrl(name: string, raw: string): string {
  const url = parseUrl(raw, ['http:', 'https:']);
  if (!url) throw new Error(`${name} must be an http(s) URL`);
  if (hasCredentials(url)) throw new Error(`${name} must not contain a username or password`);
  return raw;
}

/**
 * smtp(s)://[user:pass@]host[:port]. Credentials stay (AUTH needs them) but the host is required, because nodemailer
 * falls back to localhost without one, and a query string or fragment is refused, because nodemailer copies its
 * keys into the transport options, where they would override our hardened settings (`?debug=true`, `?logger=true`,
 * `?tls.rejectUnauthorized=false`, `?socketTimeout=...`).
 */
function smtpUrl(name: string, raw: string): string {
  const url = parseUrl(raw, ['smtp:', 'smtps:']);
  if (!url) throw new Error(`${name} must be an smtp:// or smtps:// URL (percent-encode special characters such as @ # : in the user name and password)`);
  if (url.hostname === '') throw new Error(`${name} must include a host`);
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) {
    throw new Error(`${name} must not contain a query string or fragment (percent-encode special characters in the password)`);
  }
  return raw;
}

/** A single plain address; no whitespace or list/header characters, so it cannot smuggle extra headers. */
function address(name: string, raw: string): string {
  if (!ADDRESS.test(raw)) throw new Error(`${name} must be plain email addresses like alerts@example.com`);
  return raw;
}

export function loadNotifyConfig(env: NodeJS.ProcessEnv): NotifyConfig {
  const cfg: NotifyConfig = {
    consoleUrl: httpUrl('REVIEWER_CONSOLE_URL', optional(env, 'REVIEWER_CONSOLE_URL') ?? DEFAULT_CONSOLE_URL),
  };

  const webhookUrl = optional(env, 'NOTIFY_WEBHOOK_URL');
  const webhookSecret = optional(env, 'NOTIFY_WEBHOOK_SECRET');
  if (webhookUrl) {
    cfg.webhook = { url: secureUrl('NOTIFY_WEBHOOK_URL', webhookUrl), ...(webhookSecret ? { secret: webhookSecret } : {}) };
  } else if (webhookSecret) {
    throw new Error('NOTIFY_WEBHOOK_SECRET requires NOTIFY_WEBHOOK_URL');
  }

  const slackUrl = optional(env, 'NOTIFY_SLACK_WEBHOOK_URL');
  if (slackUrl) cfg.slack = { url: secureUrl('NOTIFY_SLACK_WEBHOOK_URL', slackUrl) };

  const smtp = optional(env, 'NOTIFY_SMTP_URL');
  const from = optional(env, 'NOTIFY_EMAIL_FROM');
  const to = optional(env, 'NOTIFY_EMAIL_TO');
  if (smtp || from || to) {
    if (!smtp || !from || !to) throw new Error('Email notifications need NOTIFY_SMTP_URL, NOTIFY_EMAIL_FROM and NOTIFY_EMAIL_TO together');
    const recipients = to.split(',').map((a) => a.trim()).filter(Boolean);
    if (recipients.length === 0) throw new Error('NOTIFY_EMAIL_TO must list at least one email address');
    cfg.email = {
      smtpUrl: smtpUrl('NOTIFY_SMTP_URL', smtp),
      from: address('NOTIFY_EMAIL_FROM', from),
      to: recipients.map((a) => address('NOTIFY_EMAIL_TO', a)),
    };
  }
  return cfg;
}

/** True when at least one channel is configured. */
export const notifyEnabled = (cfg: NotifyConfig): boolean => Boolean(cfg.webhook || cfg.slack || cfg.email);

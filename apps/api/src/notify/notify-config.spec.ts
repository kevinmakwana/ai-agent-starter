import { loadConfig } from '../config';
import { loadNotifyConfig, notifyEnabled } from './notify-config';

const CONSOLE = 'http://localhost:3000/reviewer';

/** The message of the error thrown by loading `env`, or fails the test if nothing is thrown. */
function errorOf(env: NodeJS.ProcessEnv): string {
  try {
    loadNotifyConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadNotifyConfig to throw');
}

describe('loadNotifyConfig', () => {
  it('has no channels when nothing is set', () => {
    const cfg = loadNotifyConfig({});
    expect(cfg).toEqual({ consoleUrl: CONSOLE });
    expect(notifyEnabled(cfg)).toBe(false);
  });

  it('treats empty values (as in a copied .env.example) as unset', () => {
    const cfg = loadNotifyConfig({
      NOTIFY_WEBHOOK_URL: '', NOTIFY_WEBHOOK_SECRET: '', NOTIFY_SLACK_WEBHOOK_URL: '',
      NOTIFY_SMTP_URL: '', NOTIFY_EMAIL_FROM: '', NOTIFY_EMAIL_TO: '', REVIEWER_CONSOLE_URL: '',
    });
    expect(cfg).toEqual({ consoleUrl: CONSOLE });
  });

  it('is part of loadConfig with no channels by default', () => {
    const cfg = loadConfig({});
    expect(cfg.notify).toEqual({ consoleUrl: CONSOLE });
    expect(notifyEnabled(cfg.notify)).toBe(false);
  });

  describe.each([
    ['NOTIFY_WEBHOOK_URL', (c: ReturnType<typeof loadNotifyConfig>) => c.webhook?.url],
    ['NOTIFY_SLACK_WEBHOOK_URL', (c: ReturnType<typeof loadNotifyConfig>) => c.slack?.url],
  ])('%s', (name, pick) => {
    it.each([
      'https://hooks.example.com/x',
      'http://localhost:9/x',
      'http://127.0.0.1:9/x',
      'http://[::1]:9/x',
      'HTTPS://Hooks.Example.com/x',
      'HTTP://LOCALHOST:9/x',
    ])('accepts %s', (url) => {
      const cfg = loadNotifyConfig({ [name]: url });
      expect(pick(cfg)).toBe(url);
      expect(notifyEnabled(cfg)).toBe(true);
    });

    it.each([
      'http://example.com/x',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'not a url',
      'http://localhost.evil.com/x',
      'http://127.0.0.1.evil.com/x',
    ])('rejects %s without echoing it', (url) => {
      const msg = errorOf({ [name]: url });
      expect(msg).toContain(name);
      expect(msg).not.toContain(url);
    });

    it.each([
      'https://user:pw@hooks.example.com/x',
      'https://user@hooks.example.com/x',
      'https://:pw@hooks.example.com/x',
      'http://user:pw@localhost:9/x',
    ])('rejects embedded credentials in %s without echoing them', (url) => {
      const msg = errorOf({ [name]: url });
      expect(msg).toContain(name);
      expect(msg).not.toContain('pw');
      expect(msg).not.toContain(url);
    });

    it('trims a padded value', () => {
      expect(pick(loadNotifyConfig({ [name]: '  https://hooks.example.com/x \n' }))).toBe('https://hooks.example.com/x');
    });

    it('treats a whitespace-only value as unset', () => {
      expect(notifyEnabled(loadNotifyConfig({ [name]: '   ' }))).toBe(false);
    });
  });

  it('accepts a webhook secret alongside the webhook URL', () => {
    const cfg = loadNotifyConfig({ NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/x', NOTIFY_WEBHOOK_SECRET: 's3cret' });
    expect(cfg.webhook).toEqual({ url: 'https://hooks.example.com/x', secret: 's3cret' });
  });

  it('trims the webhook secret and treats a whitespace-only one as unset', () => {
    const url = 'https://hooks.example.com/x';
    expect(loadNotifyConfig({ NOTIFY_WEBHOOK_URL: url, NOTIFY_WEBHOOK_SECRET: '  s3cret ' }).webhook).toEqual({ url, secret: 's3cret' });
    expect(loadNotifyConfig({ NOTIFY_WEBHOOK_URL: url, NOTIFY_WEBHOOK_SECRET: '   ' }).webhook).toEqual({ url });
    expect(loadNotifyConfig({ NOTIFY_WEBHOOK_SECRET: '  ' })).toEqual({ consoleUrl: CONSOLE });
  });

  it('rejects a webhook secret without a webhook URL', () => {
    const msg = errorOf({ NOTIFY_WEBHOOK_SECRET: 's3cret' });
    expect(msg).toContain('NOTIFY_WEBHOOK_SECRET');
    expect(msg).not.toContain('s3cret');
  });

  describe('email', () => {
    const full = {
      NOTIFY_SMTP_URL: 'smtps://u:p@smtp.example.com:465',
      NOTIFY_EMAIL_FROM: 'alerts@example.com',
      NOTIFY_EMAIL_TO: 'a@example.com, b@example.com',
    };

    it('parses SMTP URL, sender and a comma-separated recipient list', () => {
      const cfg = loadNotifyConfig(full);
      expect(cfg.email).toEqual({
        smtpUrl: 'smtps://u:p@smtp.example.com:465',
        from: 'alerts@example.com',
        to: ['a@example.com', 'b@example.com'],
      });
      expect(notifyEnabled(cfg)).toBe(true);
    });

    it.each(['NOTIFY_SMTP_URL', 'NOTIFY_EMAIL_FROM', 'NOTIFY_EMAIL_TO'])('needs all three variables (missing %s)', (missing) => {
      const env = { ...full, [missing]: undefined };
      const msg = errorOf(env);
      for (const name of ['NOTIFY_SMTP_URL', 'NOTIFY_EMAIL_FROM', 'NOTIFY_EMAIL_TO']) expect(msg).toContain(name);
      expect(msg).not.toContain('u:p');
    });

    it('rejects a lone variable', () => {
      expect(errorOf({ NOTIFY_EMAIL_FROM: 'alerts@example.com' })).toContain('NOTIFY_SMTP_URL');
    });

    it('rejects a non-SMTP URL without echoing credentials', () => {
      const msg = errorOf({ ...full, NOTIFY_SMTP_URL: 'http://u:p@x' });
      expect(msg).toContain('NOTIFY_SMTP_URL');
      expect(msg).not.toContain('u:p');
    });

    it('rejects an unparseable SMTP URL without echoing it', () => {
      const msg = errorOf({ ...full, NOTIFY_SMTP_URL: 'u:p nonsense' });
      expect(msg).toContain('NOTIFY_SMTP_URL');
      expect(msg).not.toContain('u:p');
    });

    it.each([
      'a@example.com\nBcc: x@y.z',
      'a b@example.com',
      'nobody',
      'a@example.com, nobody',
      ' , ',
    ])('rejects bad recipients %j', (to) => {
      const msg = errorOf({ ...full, NOTIFY_EMAIL_TO: to });
      expect(msg).toContain('NOTIFY_EMAIL_TO');
      expect(msg).not.toContain('Bcc');
    });

    it('accepts an uppercase scheme and host', () => {
      expect(loadNotifyConfig({ ...full, NOTIFY_SMTP_URL: 'SMTPS://U:P@SMTP.Example.COM:465' }).email?.smtpUrl)
        .toBe('SMTPS://U:P@SMTP.Example.COM:465');
    });

    it('accepts credentials with percent-encoded special characters', () => {
      const url = 'smtp://user:p%40ss%23w%3Ard@smtp.example.com:587';
      expect(loadNotifyConfig({ ...full, NOTIFY_SMTP_URL: url }).email?.smtpUrl).toBe(url);
    });

    it.each(['smtp://', 'smtps://', 'smtp://u:p@', 'smtp://u:p@:587', 'smtp:///x'])(
      'rejects a URL without a host (%s) without echoing it',
      (url) => {
        const msg = errorOf({ ...full, NOTIFY_SMTP_URL: url });
        expect(msg).toContain('NOTIFY_SMTP_URL');
        expect(msg).not.toContain('u:p');
      },
    );

    it.each([
      'smtp://u:p@smtp.example.com:587?debug=true',
      'smtp://u:p@smtp.example.com:587?logger=true',
      'smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=false',
      'smtp://u:p@smtp.example.com:587?socketTimeout=600000',
      'smtp://u:p@smtp.example.com:587?',
      'smtp://u:p@smtp.example.com:587#frag',
      'smtp://u:pa#ss@smtp.example.com:587',
    ])('rejects a query string or fragment (%s) without echoing it', (url) => {
      const msg = errorOf({ ...full, NOTIFY_SMTP_URL: url });
      expect(msg).toContain('NOTIFY_SMTP_URL');
      expect(msg).not.toContain('u:p');
      expect(msg).not.toContain('debug');
      expect(msg).not.toContain('rejectUnauthorized');
    });

    it('trims the SMTP URL and the addresses', () => {
      const cfg = loadNotifyConfig({ ...full, NOTIFY_SMTP_URL: ' smtps://u:p@smtp.example.com:465 ', NOTIFY_EMAIL_FROM: ' alerts@example.com ' });
      expect(cfg.email?.smtpUrl).toBe('smtps://u:p@smtp.example.com:465');
      expect(cfg.email?.from).toBe('alerts@example.com');
    });

    it('ignores a trailing comma in the recipient list', () => {
      expect(loadNotifyConfig({ ...full, NOTIFY_EMAIL_TO: 'a@example.com, b@example.com,' }).email?.to)
        .toEqual(['a@example.com', 'b@example.com']);
    });

    it('rejects a bad sender address', () => {
      const msg = errorOf({ ...full, NOTIFY_EMAIL_FROM: 'alerts@example.com\nBcc: x@y.z' });
      expect(msg).toContain('NOTIFY_EMAIL_FROM');
      expect(msg).not.toContain('Bcc');
    });
  });

  describe('REVIEWER_CONSOLE_URL', () => {
    it('overrides the default link', () => {
      expect(loadNotifyConfig({ REVIEWER_CONSOLE_URL: 'https://support.example.com/reviewer' }).consoleUrl)
        .toBe('https://support.example.com/reviewer');
    });

    it('accepts an uppercase scheme and host', () => {
      expect(loadNotifyConfig({ REVIEWER_CONSOLE_URL: 'HTTPS://Support.Example.com/reviewer' }).consoleUrl)
        .toBe('HTTPS://Support.Example.com/reviewer');
    });

    it('treats a whitespace-only value as unset and trims a padded one', () => {
      expect(loadNotifyConfig({ REVIEWER_CONSOLE_URL: '   ' }).consoleUrl).toBe(CONSOLE);
      expect(loadNotifyConfig({ REVIEWER_CONSOLE_URL: ' https://support.example.com/r ' }).consoleUrl).toBe('https://support.example.com/r');
    });

    it('rejects embedded credentials without echoing them', () => {
      const msg = errorOf({ REVIEWER_CONSOLE_URL: 'https://agent:hunter2@support.example.com/reviewer' });
      expect(msg).toContain('REVIEWER_CONSOLE_URL');
      expect(msg).not.toContain('hunter2');
      expect(msg).not.toContain('agent:');
    });

    it('must be http(s)', () => {
      const msg = errorOf({ REVIEWER_CONSOLE_URL: 'ftp://x' });
      expect(msg).toContain('REVIEWER_CONSOLE_URL');
      expect(msg).not.toContain('ftp://x');
    });
  });
});

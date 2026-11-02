import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { SMTPServer } from 'smtp-server';
import { createLoginMailer } from '../src/auth/login-mailer';
import { emailChannel } from '../src/notify/email.channel';
import type { ApprovalNote } from '../src/notify/types';

// The real nodemailer transport (createSmtpTransport) talking SMTP to a real local server: AUTH, STARTTLS and the message the
// server actually receives. It proves the wire behaviour of OUR configuration. It does not prove any particular provider
// (Gmail, SES, Mailgun...) accepts it; that needs a real account.

interface Received {
  from: string;
  to: string[];
  source: string;
  user: string | undefined;
  tls: boolean;
}

const note: ApprovalNote = {
  id: 'a1',
  tool: 'issue_refund',
  orderId: 7,
  amount: 12.5,
  rule: 'over_threshold',
  createdAt: '2026-11-02T10:00:00.000Z',
  consoleUrl: 'http://localhost:3000/reviewer',
};
const signal = () => new AbortController().signal;

/** Undoes quoted-printable (soft line breaks and =XX), which nodemailer uses for long lines. */
const decode = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

let servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  servers = [];
});

async function start(opts: ConstructorParameters<typeof SMTPServer>[0] = {}) {
  const received: Received[] = [];
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: true,
    onAuth: (auth, _session, done) =>
      auth.username === 'mailer' && auth.password === 'p@ss:w/rd#1'
        ? done(null, { user: auth.username })
        : done(new Error('Invalid login')),
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          source: Buffer.concat(chunks).toString('utf8'),
          user: session.user as string | undefined,
          tls: session.secure,
        });
        done();
      });
    },
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { received, port: (server.server.address() as AddressInfo).port };
}

describe('reviewer notification email over real SMTP', () => {
  it('delivers one plain-text message with the approval headline and console link, and nothing about the customer', async () => {
    const { received, port } = await start();
    const channel = emailChannel({
      smtpUrl: `smtp://127.0.0.1:${port}`,
      from: 'support@acme.test',
      to: ['rae@acme.test', 'sam@acme.test'],
    });
    await channel.send(note, signal());
    channel.close?.();

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe('support@acme.test');
    expect(received[0].to).toEqual(['rae@acme.test', 'sam@acme.test']);
    const text = decode(received[0].source);
    expect(text).toMatch(/^Subject: Approval needed: /m);
    expect(text).toContain('http://localhost:3000/reviewer');
    expect(text).toContain('Rule: over_threshold');
    expect(text).not.toMatch(/ava\.brooks|customer@/i);
  });

  it('authenticates with a percent-encoded password, and the server sees the decoded one', async () => {
    const { received, port } = await start({ authOptional: false });
    const url = `smtp://mailer:${encodeURIComponent('p@ss:w/rd#1')}@127.0.0.1:${port}`;
    const channel = emailChannel({ smtpUrl: url, from: 'support@acme.test', to: ['rae@acme.test'] });
    await channel.send(note, signal());
    channel.close?.();
    expect(received[0].user).toBe('mailer');
  });

  it('fails with only an error code when the credentials are wrong, never with the password or server text', async () => {
    const { received, port } = await start({ authOptional: false });
    const channel = emailChannel({
      smtpUrl: `smtp://mailer:wrong-secret@127.0.0.1:${port}`,
      from: 'support@acme.test',
      to: ['rae@acme.test'],
    });
    const err = await channel.send(note, signal()).then(
      () => null,
      (e: Error) => e,
    );
    channel.close?.();
    expect(err?.message).toBe('email failed (EAUTH)');
    expect(String(err?.message)).not.toContain('wrong-secret');
    expect(received).toHaveLength(0);
  });

  it('fails cleanly, with a code and without the address, when nothing is listening', async () => {
    const { port } = await start();
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers = [];
    const channel = emailChannel({ smtpUrl: `smtp://127.0.0.1:${port}`, from: 'support@acme.test', to: ['rae@acme.test'] });
    const err = await channel.send(note, signal()).then(
      () => null,
      (e: Error) => e,
    );
    channel.close?.();
    expect(err?.message).toMatch(/^email failed( \([A-Z_]+\))?$/);
    expect(String(err?.message)).not.toContain('127.0.0.1');
  });
});

// A real certificate for 127.0.0.1, made for this run. Whether the client TRUSTS it is the only thing that differs between the
// two cases below, so the first failing and the second succeeding can only be about certificate verification.
const canTrustOwnCa = typeof (tls as { setDefaultCACertificates?: unknown }).setDefaultCACertificates === 'function';
const maybeTls = canTrustOwnCa && spawnSync('openssl', ['version']).status === 0 ? describe : describe.skip;

maybeTls('TLS', () => {
  let key: string;
  let cert: string;
  type CaApi = { setDefaultCACertificates(c: string[]): void; getCACertificates(t: 'default'): string[] };
  const caApi = tls as unknown as CaApi;
  let originalCa: string[];

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'smtp-tls-'));
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    const made = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ]);
    if (made.status !== 0) throw new Error(`openssl could not make a test certificate: ${made.stderr}`);
    key = readFileSync(keyFile, 'utf8');
    cert = readFileSync(certFile, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    originalCa = caApi.getCACertificates('default');
  });
  afterAll(() => caApi.setDefaultCACertificates(originalCa));

  const send = async (url: string) => {
    const channel = emailChannel({ smtpUrl: url, from: 'support@acme.test', to: ['rae@acme.test'] });
    try {
      await channel.send(note, signal());
      return null;
    } catch (e) {
      return e as Error;
    } finally {
      channel.close?.();
    }
  };

  it('refuses a STARTTLS server whose certificate it does not trust, and delivers nothing', async () => {
    caApi.setDefaultCACertificates(originalCa);
    const { received, port } = await start({ disabledCommands: [], key, cert });
    const err = await send(`smtp://127.0.0.1:${port}`);
    expect(err?.message).toBe('email failed (ESOCKET)');
    expect(received).toHaveLength(0);
  });

  it('refuses an smtps server whose certificate it does not trust', async () => {
    caApi.setDefaultCACertificates(originalCa);
    const { received, port } = await start({ secure: true, disabledCommands: [], key, cert });
    expect((await send(`smtps://127.0.0.1:${port}`))?.message).toBe('email failed (ESOCKET)');
    expect(received).toHaveLength(0);
  });

  describe('once the certificate is trusted', () => {
    beforeEach(() => caApi.setDefaultCACertificates([...originalCa, cert]));
    afterEach(() => caApi.setDefaultCACertificates(originalCa));

    it('upgrades with STARTTLS and delivers over the encrypted session', async () => {
      const { received, port } = await start({ disabledCommands: [], key, cert });
      expect(await send(`smtp://127.0.0.1:${port}`)).toBeNull();
      expect(received).toHaveLength(1);
      expect(received[0].tls).toBe(true);
    });

    it('delivers over implicit TLS (smtps) too', async () => {
      const { received, port } = await start({ secure: true, disabledCommands: [], key, cert });
      expect(await send(`smtps://127.0.0.1:${port}`)).toBeNull();
      expect(received[0].tls).toBe(true);
    });

    it('sends AUTH credentials only inside the encrypted session', async () => {
      // allowInsecureAuth is off: the server refuses AUTH on a plaintext connection, so success proves the upgrade came first.
      const { received, port } = await start({ disabledCommands: [], key, cert, authOptional: false, allowInsecureAuth: false });
      const url = `smtp://mailer:${encodeURIComponent('p@ss:w/rd#1')}@127.0.0.1:${port}`;
      expect(await send(url)).toBeNull();
      expect(received[0]).toMatchObject({ user: 'mailer', tls: true });
    });
  });
});

describe('customer sign-in email over real SMTP', () => {
  it('delivers the one-time link and its lifetime, to the customer only', async () => {
    const { received, port } = await start();
    const mailer = createLoginMailer({ smtpUrl: `smtp://127.0.0.1:${port}`, from: 'login@acme.test' });
    const link = 'http://localhost:3000/login#token=' + 'a'.repeat(43);
    await mailer.sendLink('ava.brooks@example.com', link, 15);
    mailer.close();

    expect(received).toHaveLength(1);
    expect(received[0].to).toEqual(['ava.brooks@example.com']);
    const text = decode(received[0].source);
    expect(text).toMatch(/^Subject: Your sign-in link/m);
    expect(text).toContain(link);
    expect(text).toContain('expires in 15 minutes');
  });

  it('reports a rejected recipient as a code only, without echoing the address', async () => {
    const { port } = await start({ onRcptTo: (_a, _s, done) => done(new Error('550 no such user ava.brooks@example.com')) });
    const mailer = createLoginMailer({ smtpUrl: `smtp://127.0.0.1:${port}`, from: 'login@acme.test' });
    const err = await mailer.sendLink('ava.brooks@example.com', 'http://x/#t', 15).then(
      () => null,
      (e: Error) => e,
    );
    mailer.close();
    expect(err?.message).toMatch(/^login email failed( \([A-Z_]+\))?$/);
    expect(String(err?.message)).not.toContain('ava.brooks');
  });
});

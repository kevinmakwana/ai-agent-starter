import { Logger, UnauthorizedException } from '@nestjs/common';
import { MemoryCustomerAuthStore } from '../../test/fake-customers';
import { loadConfig } from '../config';
import { CUSTOMER_COOKIE } from './cookie';
import { CustomerAuthService } from './customer-auth.service';
import type { LoginMailer } from './login-mailer';

const AVA = { id: 1, name: 'Ava Brooks', email: 'ava.brooks@example.com' };
const BEN = { id: 2, name: 'Ben Carter', email: 'ben.carter@example.com' };
const MAIL = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const T0 = 1_800_000_000_000;

function setup(env: NodeJS.ProcessEnv = {}, mailerOverride?: LoginMailer | null) {
  const store = new MemoryCustomerAuthStore([AVA, BEN]);
  let t = T0;
  store.now = () => t;
  const sent: { to: string; link: string; ttl: number }[] = [];
  const mailer: LoginMailer = { sendLink: async (to, link, ttl) => { sent.push({ to, link, ttl }); }, close: jest.fn() };
  const service = new CustomerAuthService(store, loadConfig({ ...MAIL, ...env }), mailerOverride === undefined ? mailer : mailerOverride);
  const request = async (email: string) => { await service.requestLink(email); await service.drain(); };
  const tokenOf = (link: string) => link.split('#token=')[1];
  return { store, service, sent, request, tokenOf, advance: (ms: number) => { t += ms; } };
}
const cookie = (token: string) => ({ headers: { cookie: `${CUSTOMER_COOKIE}=${token}` } });

afterEach(() => jest.restoreAllMocks());

describe('requestLink', () => {
  it('mails a link to a known customer, matching the email case-insensitively and ignoring surrounding spaces', async () => {
    const { request, sent, tokenOf } = setup();
    await request('  AVA.Brooks@Example.com ');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: AVA.email, ttl: 15 });
    expect(sent[0].link).toMatch(/^http:\/\/localhost:3000\/login#token=[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(sent[0].link)).toHaveLength(43);
  });

  it('does nothing visible for an unknown email: no mail, no stored link', async () => {
    const { request, sent, store } = setup();
    await request('nobody@example.com');
    expect(sent).toHaveLength(0);
    expect(store.links).toHaveLength(0);
  });

  it('does nothing without a mailer (login off)', async () => {
    const { request, store } = setup({}, null);
    await request(AVA.email);
    expect(store.links).toHaveLength(0);
  });

  it('answers before the mail is sent, so a slow mail server cannot tell a known email from an unknown one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: LoginMailer = { sendLink: () => gate, close: jest.fn() };
    const { service } = setup({}, slow);
    const answered = await Promise.race([service.requestLink(AVA.email).then(() => 'answered'), new Promise((r) => setTimeout(() => r('waited'), 200))]);
    expect(answered).toBe('answered');
    release();
    await service.drain();
  });

  it('never lets a mail or store failure escape, and logs neither the address nor the link', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing: LoginMailer = { sendLink: async () => { throw Object.assign(new Error(`550 no such user ${AVA.email}`), { code: 'EENVELOPE' }); }, close: jest.fn() };
    const { service } = setup({}, failing);
    await expect(service.requestLink(AVA.email)).resolves.toBeUndefined();
    await expect(service.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/ava|example\.com|token=/i);
  });

  it('creates at most 5 links per customer per rolling hour, then goes quiet', async () => {
    const { request, sent, advance } = setup();
    for (let i = 0; i < 7; i++) await request(AVA.email);
    expect(sent).toHaveLength(5);
    await request(BEN.email); // another customer is unaffected
    expect(sent).toHaveLength(6);
    advance(61 * 60_000);
    await request(AVA.email);
    expect(sent).toHaveLength(7);
  });
});

describe('verify', () => {
  it('turns a link into a session and consumes the link', async () => {
    const { request, sent, tokenOf, service } = setup();
    await request(AVA.email);
    const link = tokenOf(sent[0].link);
    const { token, customer } = await service.verify(link);
    expect(customer).toEqual(AVA);
    expect(token).not.toBe(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await service.resolve(cookie(token))).toEqual(AVA);
    await expect(service.verify(link)).rejects.toThrow('Invalid or expired link'); // single use
  });

  it('refuses expired, unknown, empty, absurdly long and superseded links with one error', async () => {
    const { request, sent, tokenOf, service, advance } = setup();
    await request(AVA.email);
    advance(16 * 60_000);
    const errors = [
      await service.verify(tokenOf(sent[0].link)).catch((e) => e), // expired
      await service.verify('not-a-real-token').catch((e) => e),
      await service.verify('').catch((e) => e),
      await service.verify('x'.repeat(10_000)).catch((e) => e),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.message).toBe('Invalid or expired link');
    }
  });

  it('keeps only the 2 newest unused links of a customer', async () => {
    const { request, sent, tokenOf, service, advance } = setup();
    for (let i = 0; i < 3; i++) { await request(AVA.email); advance(1000); }
    await expect(service.verify(tokenOf(sent[0].link))).rejects.toThrow('Invalid or expired link');
    await expect(service.verify(tokenOf(sent[1].link))).resolves.toMatchObject({ customer: AVA });
    await expect(service.verify(tokenOf(sent[2].link))).resolves.toMatchObject({ customer: AVA });
  });

  it('removes expired sessions when someone signs in', async () => {
    const { request, sent, tokenOf, service, advance, store } = setup();
    await request(AVA.email);
    const first = await service.verify(tokenOf(sent[0].link));
    advance(8 * 86_400_000);
    await request(AVA.email);
    await service.verify(tokenOf(sent[1].link));
    expect(store.sessions.size).toBe(1);
    expect(await service.resolve(cookie(first.token))).toBeNull();
  });
});

describe('sessions', () => {
  const signIn = async (ctx: ReturnType<typeof setup>, email = AVA.email) => {
    await ctx.request(email);
    return ctx.service.verify(ctx.tokenOf(ctx.sent.at(-1)!.link));
  };

  it('ends after the absolute lifetime and after 24 idle hours', async () => {
    const ctx = setup({ CUSTOMER_SESSION_TTL_DAYS: '2' });
    const { token } = await signIn(ctx);
    ctx.advance(23 * 3_600_000);
    expect(await ctx.service.resolve(cookie(token))).toEqual(AVA); // keeps it fresh
    ctx.advance(23 * 3_600_000);
    expect(await ctx.service.resolve(cookie(token))).toEqual(AVA);
    ctx.advance(2 * 3_600_000); // 48 h since the start: past the absolute lifetime
    expect(await ctx.service.resolve(cookie(token))).toBeNull();
    const second = await signIn(ctx);
    ctx.advance(25 * 3_600_000);
    expect(await ctx.service.resolve(cookie(second.token))).toBeNull(); // idle
  });

  it('logout ends one session, logoutAll every session of that customer only', async () => {
    const ctx = setup();
    const a1 = await signIn(ctx);
    const a2 = await signIn(ctx);
    const ben = await signIn(ctx, BEN.email);
    await ctx.service.logout(a1.token);
    expect(await ctx.service.resolve(cookie(a1.token))).toBeNull();
    expect(await ctx.service.resolve(cookie(a2.token))).toEqual(AVA);
    await ctx.service.logoutAll(AVA.id);
    expect(await ctx.service.resolve(cookie(a2.token))).toBeNull();
    expect(await ctx.service.resolve(cookie(ben.token))).toEqual(BEN);
  });

  it('knows nothing from a missing, foreign or made-up cookie', async () => {
    const { service } = setup();
    expect(await service.resolve({ headers: {} })).toBeNull();
    expect(await service.resolve({ headers: { cookie: 'reviewer_session=abc' } })).toBeNull();
    expect(await service.resolve(cookie('made-up'))).toBeNull();
  });

  it('reports whether login is on', () => {
    expect(setup().service.enabled).toBe(true);
    expect(new CustomerAuthService(new MemoryCustomerAuthStore([]), loadConfig({}), null).enabled).toBe(false);
  });
});

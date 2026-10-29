import * as nodemailer from 'nodemailer';
import { emailChannel } from './email.channel';
import type { ApprovalNote } from './types';

const note = (over: Partial<ApprovalNote> = {}): ApprovalNote => ({
  id: 'a1', tool: 'issue_refund', orderId: 11, amount: 18.75, rule: 'always_review',
  createdAt: '2026-10-29T10:00:00.000Z', consoleUrl: 'https://console.example.com/reviewer', ...over,
});

const options = { smtpUrl: 'smtp://user:pass@smtp.example.com:587', from: 'bot@example.com', to: ['a@example.com', 'b@example.com'] };

/** A transport stand-in whose `sendMail` is the given function. */
const fakeTransport = (sendMail: () => Promise<unknown>) => {
  const close = jest.fn();
  return { transport: { sendMail, close } as unknown as nodemailer.Transporter, close };
};

/** The options nodemailer built for a channel created from a URL (the transporter is reached through `close`'s owner). */
function builtOptions(smtpUrl: string): Record<string, unknown> {
  const spy = jest.spyOn(nodemailer, 'createTransport');
  try {
    emailChannel({ ...options, smtpUrl });
    const transporter = spy.mock.results[0].value as nodemailer.Transporter;
    return (transporter.transporter as unknown as { options: Record<string, unknown> }).options;
  } finally {
    spy.mockRestore();
  }
}

describe('emailChannel transport', () => {
  it.each([
    'smtp://u:p@smtp.example.com:587',
    'SMTP://u:p@SMTP.Example.com',
    'smtp://u:p@localhost.evil.com:25',
    'smtp://u:p@10.0.0.5:25',
  ])('requires STARTTLS for the remote plaintext-start host %s', (url) => {
    expect(builtOptions(url).requireTLS).toBe(true);
  });

  it.each([
    'smtp://localhost:1025',
    'smtp://LOCALHOST:1025',
    'smtp://127.0.0.1:1025',
    'smtp://[::1]:1025',
    'smtps://u:p@smtp.example.com:465',
  ])('does not force STARTTLS for %s', (url) => {
    expect(builtOptions(url).requireTLS).toBeFalsy();
  });

  it('keeps the 5 s network timeouts and never turns on logging', () => {
    const o = builtOptions('smtp://u:p@smtp.example.com:587');
    expect(o).toMatchObject({ connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, dnsTimeout: 5000 });
    expect(o.logger).toBeFalsy();
    expect(o.debug).toBeFalsy();
    expect(o.transactionLog).toBeFalsy();
  });

  it('keeps TLS from the start for smtps', () => {
    expect(builtOptions('smtps://u:p@smtp.example.com:465')).toMatchObject({ secure: true, port: 465 });
  });

  it('asks for a 20 s attempt allowance, longer than the notifier default', () => {
    expect(emailChannel({ ...options, transport: nodemailer.createTransport({ jsonTransport: true }) }).timeoutMs).toBe(20_000);
  });
});

describe('emailChannel', () => {
  it('sends one plain-text message to every recipient', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = jest.spyOn(transport, 'sendMail');
    const channel = emailChannel({ ...options, transport });
    expect(channel.name).toBe('email');

    await channel.send(note(), new AbortController().signal);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const info = (await sendMail.mock.results[0].value) as { message: string };
    const msg = JSON.parse(info.message);
    expect(msg.from).toEqual({ address: 'bot@example.com', name: '' });
    expect(msg.to.map((r: { address: string }) => r.address)).toEqual(['a@example.com', 'b@example.com']);
    expect(msg.subject).toBe('Approval needed: refund $18.75 on order #11');
    expect(msg.text).toContain('refund $18.75 on order #11');
    expect(msg.text).toContain('Rule: always_review');
    expect(msg.text).toContain('Requested: 2026-10-29T10:00:00.000Z');
    expect(msg.text).toContain('https://console.example.com/reviewer');
    expect(msg.html).toBeUndefined();
  });

  it('reports only the error code, never the server text', async () => {
    const err = Object.assign(new Error('Invalid login: 535 user:pass@smtp'), { code: 'EAUTH' });
    const { transport } = fakeTransport(async () => { throw err; });
    const channel = emailChannel({ ...options, transport });
    await expect(channel.send(note(), new AbortController().signal)).rejects.toThrow(/^email failed \(EAUTH\)$/);
  });

  it('reports a bare failure when the error has no code', async () => {
    const { transport } = fakeTransport(async () => { throw new Error('boom user:pass@smtp'); });
    const channel = emailChannel({ ...options, transport });
    await expect(channel.send(note(), new AbortController().signal)).rejects.toThrow(/^email failed$/);
  });

  it('ignores a code that is not a short token', async () => {
    const err = Object.assign(new Error('x'), { code: 'user:pass@smtp, it failed' });
    const { transport } = fakeTransport(async () => { throw err; });
    const channel = emailChannel({ ...options, transport });
    await expect(channel.send(note(), new AbortController().signal)).rejects.toThrow(/^email failed$/);
  });

  it('times out when the signal is already aborted, even if sendMail never settles', async () => {
    const { transport } = fakeTransport(() => new Promise(() => undefined));
    const channel = emailChannel({ ...options, transport });
    await expect(channel.send(note(), AbortSignal.abort())).rejects.toThrow(/^timed out$/);
  });

  it('times out when the signal aborts later, even if sendMail never settles', async () => {
    const { transport } = fakeTransport(() => new Promise(() => undefined));
    const channel = emailChannel({ ...options, transport });
    const controller = new AbortController();
    const sent = channel.send(note(), controller.signal);
    controller.abort();
    await expect(sent).rejects.toThrow(/^timed out$/);
  });

  it('closes the transport', () => {
    const { transport, close } = fakeTransport(async () => undefined);
    emailChannel({ ...options, transport }).close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

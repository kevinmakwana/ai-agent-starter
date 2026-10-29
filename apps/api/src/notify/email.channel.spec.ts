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

import * as nodemailer from 'nodemailer';
import { createLoginMailer } from './login-mailer';

const link = 'http://localhost:3000/login#token=abcDEF123_-xyz';
const options = { smtpUrl: 'smtp://u:p@smtp.example.com:587', from: 'support@example.com' };
const jsonTransport = () => nodemailer.createTransport({ jsonTransport: true });

describe('createLoginMailer', () => {
  it('sends one plain-text mail with the link and how long it lasts, and nothing else about the customer', async () => {
    const transport = jsonTransport();
    const send = jest.spyOn(transport, 'sendMail');
    await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0] as { from: string; to: string; subject: string; text: string; html?: string };
    expect(mail).toMatchObject({ from: 'support@example.com', to: 'ava@example.com', subject: 'Your sign-in link' });
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('15 minutes');
    expect(mail.html).toBeUndefined();
    expect(mail.text).not.toMatch(/ava|order|conversation/i);
  });

  it('reports only a short error code, never the server text, the address or the link', async () => {
    const transport = jsonTransport();
    const authError = Object.assign(new Error('535 auth failed for ava@example.com via smtp://u:p@host'), { code: 'EAUTH' });
    jest.spyOn(transport, 'sendMail').mockImplementation(() => Promise.reject(authError));
    const err = await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15).catch((e) => e);
    expect(err.message).toBe('login email failed (EAUTH)');
    jest.spyOn(transport, 'sendMail').mockImplementation(() => Promise.reject(new Error('boom with ava@example.com')));
    const plain = await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15).catch((e) => e);
    expect(plain.message).toBe('login email failed');
  });

  it('closes the transport', () => {
    const transport = jsonTransport();
    const close = jest.spyOn(transport, 'close');
    createLoginMailer({ ...options, transport }).close();
    expect(close).toHaveBeenCalled();
  });

  it('builds the same hardened transport as the notification email channel when none is given', () => {
    const spy = jest.spyOn(nodemailer, 'createTransport');
    try {
      createLoginMailer(options);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        url: options.smtpUrl, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, requireTLS: true,
      }));
      const built = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(built.logger).toBeUndefined();
      expect(built.debug).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

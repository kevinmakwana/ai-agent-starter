import type * as nodemailer from 'nodemailer';
import { createSmtpTransport } from '../notify/email.channel';

export interface LoginMailer {
  sendLink(to: string, link: string, ttlMinutes: number): Promise<void>;
  close(): void;
}

/** Only a short upper-case token such as `EAUTH` is reported: server text can echo the address or credentials. */
const CODE = /^[A-Z0-9_]{1,32}$/;

/** The sign-in mail: plain text, the link and its lifetime, no customer data. Failures carry at most an error code. */
export function createLoginMailer({ smtpUrl, from, transport }: { smtpUrl: string; from: string; transport?: nodemailer.Transporter }): LoginMailer {
  const transporter = transport ?? createSmtpTransport(smtpUrl);
  return {
    async sendLink(to, link, ttlMinutes) {
      const text = [
        `Use this link to sign in to Acme Shop support. It works once and expires in ${ttlMinutes} minutes:`,
        '',
        link,
        '',
        'If you did not ask for it, you can ignore this email.',
      ].join('\n');
      try {
        await transporter.sendMail({ from, to, subject: 'Your sign-in link', text });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        // the validated code travels as `.code` too, so the caller can log it without parsing the message
        if (typeof code === 'string' && CODE.test(code)) throw Object.assign(new Error(`login email failed (${code})`), { code });
        throw new Error('login email failed');
      }
    },
    close() {
      transporter.close();
    },
  };
}

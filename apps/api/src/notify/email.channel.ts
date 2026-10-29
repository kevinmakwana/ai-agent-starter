import * as nodemailer from 'nodemailer';
import { abortable } from './abortable';
import { headline, plainText } from './format';
import type { ApprovalNote, Channel } from './types';

export interface EmailOptions {
  smtpUrl: string;
  from: string;
  to: string[];
  transport?: nodemailer.Transporter;
}

const TIMEOUT_MS = 5000;

/** Only a short, upper-case token such as `EAUTH` is reported; the rest of the error (server text) never leaves. */
const CODE = /^[A-Z0-9_]{1,32}$/;

const failure = (err: unknown): Error => {
  const code = (err as { code?: unknown } | null)?.code;
  return new Error(typeof code === 'string' && CODE.test(code) ? `email failed (${code})` : 'email failed');
};

/** Plain-text email through SMTP. No `logger` or `debug` on the transport: it would print credentials and traffic. */
export function emailChannel({ smtpUrl, from, to, transport }: EmailOptions): Channel {
  const transporter =
    transport ??
    nodemailer.createTransport({
      url: smtpUrl,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      dnsTimeout: TIMEOUT_MS,
    });
  return {
    name: 'email',
    async send(note: ApprovalNote, signal: AbortSignal): Promise<void> {
      try {
        await abortable(signal, () =>
          transporter.sendMail({ from, to, subject: `Approval needed: ${headline(note)}`, text: plainText(note) }),
        );
      } catch (err) {
        if (err instanceof Error && err.message === 'timed out') throw err;
        throw failure(err);
      }
    },
    close(): void {
      transporter.close();
    },
  };
}

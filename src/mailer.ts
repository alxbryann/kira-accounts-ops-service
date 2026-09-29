import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

export type Mail = { to: string; subject: string; text: string; html?: string };
export interface MailTransport { send(mail: Mail): Promise<void>; verify?(): Promise<void> }

// Picks the transport from the environment, first match wins:
//  - SMTP_URL (e.g. smtp://user:pass@smtp.example.com:587)
//  - Gmail: `gmail` (the account address) + `gmail_api_key` (a Gmail *app password*, not an API key)
//  - otherwise each mail is written to logs/mail/*.eml, so local runs and demos need no external service.
export function mailTransportFromEnv(env = process.env): MailTransport {
  if (env.gmail && env.gmail_api_key && !env.SMTP_URL) {
    // Gmail sends as the authenticated account regardless of `from`, so use it as the sender.
    const gmail = nodemailer.createTransport({ service: 'gmail', auth: { user: env.gmail, pass: env.gmail_api_key } });
    return { async send(m) { await gmail.sendMail({ from: env.gmail, ...m }); }, verify: () => gmail.verify().then(() => {}) };
  }
  const from = env.ALERT_EMAIL_FROM ?? 'kira-ops@localhost';
  if (env.SMTP_URL) {
    const smtp = nodemailer.createTransport(env.SMTP_URL);
    return { async send(m) { await smtp.sendMail({ from, ...m }); }, verify: () => smtp.verify().then(() => {}) };
  }
  const dir = path.join(process.cwd(), 'logs', 'mail');
  const file = nodemailer.createTransport({ streamTransport: true, buffer: true });
  return {
    async send(m) {
      const info = await file.sendMail({ from, ...m });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.eml`), info.message as Buffer);
    },
  };
}

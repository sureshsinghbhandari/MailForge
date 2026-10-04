import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { SMTP_HOST, SMTP_PORT } from './env.js';

/** Sends mail the way an application under test would: plain SMTP to the capture server. */
export async function sendMail(options: Mail.Options): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    ignoreTLS: true,
    tls: { rejectUnauthorized: false },
  });
  try {
    await transporter.sendMail({ from: 'noreply@example.com', ...options });
  } finally {
    transporter.close();
  }
}

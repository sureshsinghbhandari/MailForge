import type { PublicSettings } from './types';

export function buildSnippet(settings: Pick<PublicSettings, 'smtpHost' | 'smtpPort'>, to: string): string {
  return `import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({
  host: ${JSON.stringify(settings.smtpHost)},
  port: ${settings.smtpPort},
  secure: false, // plain SMTP capture, no auth
});

await transport.sendMail({
  from: 'sender@example.com',
  to: ${JSON.stringify(to)},
  subject: 'Test email',
  text: 'Your verification code is 123456',
  html: '<p>Your verification code is <b>123456</b></p>',
});`;
}

/**
 * Sends a sample email straight to the local SMTP capture server (what an application under test does).
 *
 *   npm run send-test-mail -w tests -- test-abc123@mailtest.local
 *   npm run send-test-mail -w tests -- <address> "Custom subject" "Your verification code is 123456"
 *
 * Env: SMTP_HOST (default 127.0.0.1), SMTP_PORT (default 11025; use 1025 with the Docker stack).
 */
import nodemailer from 'nodemailer';

const [to, subject = 'Verify your account', body = 'Your verification code is 482913\nVerify: https://app.example.com/verify?token=abc123'] =
  process.argv.slice(2);
if (!to) {
  console.error('usage: send-test-mail <address> [subject] [text]');
  process.exit(2);
}

const transporter = nodemailer.createTransport({
  host: process.env['SMTP_HOST'] ?? '127.0.0.1',
  port: Number(process.env['SMTP_PORT'] ?? 11025),
  secure: false,
  ignoreTLS: true,
});

try {
  const info = await transporter.sendMail({
    from: 'Example App <noreply@example.com>',
    to,
    subject,
    text: body,
    html: `<p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
  });
  console.log(`accepted by SMTP server: ${info.accepted.join(', ')}`);
} catch (err) {
  console.error(`SMTP delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  transporter.close();
}

/**
 * Development seed data: 3 mailboxes and 5 messages (plain text, HTML, verification codes, links,
 * an attachment and a deliberately hostile HTML email to demonstrate sanitisation).
 * Refuses to run in production.
 */
import { mkdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { createDb } from '../db/index.js';
import { defaultMigrationsDir, runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';

const CRLF = '\r\n';

function message(headers: Record<string, string>, body: string): Buffer {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return Buffer.from([...head, 'MIME-Version: 1.0', '', body].join(CRLF), 'utf8');
}

function alternative(to: string, from: string, subject: string, text: string, html: string): Buffer {
  const b = 'seed-boundary-alt';
  const body = [
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    `--${b}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    `--${b}--`,
    '',
  ].join(CRLF);
  return message({ From: from, To: to, Subject: subject, Date: new Date().toUTCString(), 'Content-Type': `multipart/alternative; boundary="${b}"` }, body);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('../.env');
  } catch {
    /* optional */
  }
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed data when NODE_ENV=production.');
    process.exit(1);
  }
  const log = createLogger('warn');
  const db = await createDb(config.DATABASE_URL);
  await runMigrations(db, config.MIGRATIONS_DIR ?? defaultMigrationsDir(), log);
  await mkdir(config.ATTACHMENT_DIR, { recursive: true });
  const ctx = createContext({ config, log, db });
  await ctx.auth.bootstrapAdmin();

  const ttl = Math.min(1440, config.MAX_MAILBOX_TTL_MINUTES);
  const [signup, billing, reset] = await Promise.all(
    ['signup', 'billing', 'reset'].map((prefix) => ctx.mailboxes.create({ prefix, ttlMinutes: ttl }, { userId: null })),
  );
  if (!signup || !billing || !reset) throw new Error('seed mailboxes were not created');

  const deliver = async (to: string, raw: Buffer) => {
    const out = await ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [to] });
    if (out.stored.length === 0) throw new Error(`seed message for ${to} was not stored (${out.skipped})`);
  };

  await deliver(
    signup.email,
    alternative(
      signup.email,
      'Example App <noreply@example.com>',
      'Verify your account',
      'Welcome!\r\n\r\nYour verification code is 482913\r\n\r\nOr verify directly: https://app.example.com/verify?token=abc123\r\n',
      '<html><body style="font-family:sans-serif"><h2>Welcome!</h2><p>Your verification code is <b style="font-size:24px">482913</b></p>' +
        '<p><a href="https://app.example.com/verify?token=abc123">Verify my email</a></p></body></html>',
    ),
  );

  await deliver(
    signup.email,
    message(
      { From: 'Example App <hello@example.com>', To: signup.email, Subject: 'Welcome to Example App', 'Content-Type': 'text/plain; charset=utf-8' },
      'Hi there,\r\n\r\nThanks for joining. Get started at https://app.example.com/login\r\n\r\nUnsubscribe: https://app.example.com/unsubscribe?u=1\r\n',
    ),
  );

  const b = 'seed-boundary-mixed';
  await deliver(
    billing.email,
    message(
      {
        From: 'Billing <billing@example.com>',
        To: billing.email,
        Subject: 'Invoice 20260412 - total $1234.00',
        'Content-Type': `multipart/mixed; boundary="${b}"`,
      },
      [
        `--${b}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Your invoice 20260412 for $1234.00 is attached. Call +1 555 123 4567 with questions.',
        `--${b}`,
        'Content-Type: text/plain; name="invoice.txt"',
        'Content-Disposition: attachment; filename="invoice.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Invoice 20260412\nTotal: $1234.00\n').toString('base64'),
        `--${b}--`,
        '',
      ].join(CRLF),
    ),
  );

  await deliver(
    reset.email,
    alternative(
      reset.email,
      'Example App Security <security@example.com>',
      'Reset your password',
      'Your OTP is 839204. It expires in 10 minutes.\r\nReset: https://app.example.com/reset-password?token=r3s3t\r\n',
      '<p>Your OTP is <b>839204</b>. It expires in 10 minutes.</p><p><a href="https://app.example.com/reset-password?token=r3s3t">Reset password</a></p>',
    ),
  );

  await deliver(
    reset.email,
    alternative(
      reset.email,
      'Totally Legit <phish@example.net>',
      'HTML sanitisation demo',
      'This message contains hostile HTML. Open the HTML tab: nothing should execute.',
      '<p>Hello <b>there</b></p><script>alert("xss")</script><img src="x" onerror="alert(1)">' +
        '<a href="javascript:alert(1)">click me</a><iframe src="https://evil.example"></iframe>',
    ),
  );

  console.log('Seeded mailboxes:');
  for (const m of [signup, billing, reset]) console.log(`  ${m.email}`);
  await db.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

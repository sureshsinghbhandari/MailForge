import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import request from 'supertest';
import { loadConfig, type Config } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import { createDb } from '../../src/db/index.js';
import { defaultMigrationsDir, runMigrations } from '../../src/db/migrate.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/logger.js';
import type { CapturedMessageSummary, MailSource } from '../../src/services/mailpitClient.js';

export const ADMIN_EMAIL = 'admin@mailtest.local';
export const ADMIN_PASSWORD = 'a-long-test-password-1';

export class FakeMailSource implements MailSource {
  readonly messages = new Map<string, { raw: Buffer; recipients: string[] }>();
  healthy = true;
  private counter = 0;

  push(raw: Buffer, recipients: string[]): string {
    const id = `fake-${++this.counter}`;
    this.messages.set(id, { raw, recipients });
    return id;
  }

  async list(limit: number): Promise<CapturedMessageSummary[]> {
    return [...this.messages.entries()]
      .slice(0, limit)
      .map(([id, m]) => ({ id, size: m.raw.length, recipients: m.recipients }));
  }

  async getRaw(id: string): Promise<Buffer> {
    const m = this.messages.get(id);
    if (!m) throw new Error('not found');
    return m.raw;
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.messages.delete(id);
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

export interface TestEnv {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  source: FakeMailSource;
  attachmentDir: string;
  /** Logs in and returns an authenticated supertest agent that sends the CSRF header automatically. */
  login(): Promise<AuthedAgent>;
  /** Removes all data between tests (users are kept). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface AuthedAgent {
  get(url: string): request.Test;
  post(url: string): request.Test;
  patch(url: string): request.Test;
  delete(url: string): request.Test;
  csrfToken: string;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const attachmentDir = await mkdtemp(path.join(os.tmpdir(), 'mailforge-att-'));
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    MAIL_DOMAIN: 'mailtest.local',
    ATTACHMENT_DIR: attachmentDir,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    LOG_LEVEL: 'silent',
    // High defaults so only tests that exercise limits hit them.
    LOGIN_RATE_LIMIT: '1000/1h',
    API_RATE_LIMIT: '100000/1h',
    MAILBOX_CREATION_RATE_LIMIT: '100000/1h',
    SEARCH_RATE_LIMIT: '100000/1h',
    DOWNLOAD_RATE_LIMIT: '100000/1h',
    ...overrides,
  });
  const log = createLogger('silent');
  const db = await createDb(config.DATABASE_URL);
  await runMigrations(db, defaultMigrationsDir());
  const source = new FakeMailSource();
  const ctx = createContext({ config, log, db, source });
  await ctx.auth.bootstrapAdmin();
  const app = createApp(ctx);

  return {
    ctx,
    app,
    source,
    attachmentDir,
    async login() {
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
      const csrfToken = res.body.data.csrfToken as string;
      const withCsrf = (t: request.Test) => t.set('X-CSRF-Token', csrfToken);
      return {
        csrfToken,
        get: (url) => agent.get(url),
        post: (url) => withCsrf(agent.post(url)),
        patch: (url) => withCsrf(agent.patch(url)),
        delete: (url) => withCsrf(agent.delete(url)),
      };
    },
    async reset() {
      await ctx.db.query('TRUNCATE mailboxes, audit_logs, api_keys, sessions CASCADE');
    },
    async close() {
      await ctx.db.close();
      await rm(attachmentDir, { recursive: true, force: true });
    },
  };
}

export async function buildEmail(options: Mail.Options): Promise<Buffer> {
  return new MailComposer({ from: 'noreply@example.com', ...options }).compile().build();
}

/** Creates a mailbox and delivers a message to it through the real ingest pipeline. */
export async function deliver(
  env: TestEnv,
  mailboxAddress: string,
  options: Mail.Options,
): Promise<{ messageId: string; mailboxId: string }> {
  const raw = await buildEmail({ to: mailboxAddress, ...options });
  const outcome = await env.ctx.ingest.ingest({ raw, sourceId: null, envelopeRecipients: [mailboxAddress] });
  const stored = outcome.stored[0];
  if (!stored) throw new Error(`message was not stored (${outcome.skipped})`);
  return stored;
}

export async function createMailbox(env: TestEnv, body: Record<string, unknown> = {}) {
  const agent = await env.login();
  const res = await agent.post('/api/mailboxes').send(body);
  if (res.status !== 201) throw new Error(`create mailbox failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; email: string; expiresAt: string };
}

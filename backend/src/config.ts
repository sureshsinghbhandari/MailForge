import { z } from 'zod';
import { parseRateSpec } from './lib/rateSpec.js';

const KNOWN_WEAK_PASSWORDS = new Set(['change-me-please-123', 'password', 'admin', 'changeme']);

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const rate = z.string().refine((v) => {
  try {
    parseRateSpec(v);
    return true;
  } catch {
    return false;
  }
}, 'must look like 10/15m or 100/hour');

const domainList = z
  .string()
  .min(1)
  .transform((v) =>
    v
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine((list) => list.length > 0 && list.every((d) => /^(?=.{1,253}$)([a-z0-9-]+\.)*[a-z0-9-]+$/.test(d)), {
    message: 'must be a comma separated list of valid domain names',
  });

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('Private Mail Testing'),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().default('false'),

    DATABASE_URL: z.string().min(1),

    SMTP_HOST: z.string().default('mailpit'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    MAILPIT_API_URL: z.string().url().default('http://mailpit:8025'),
    INGEST_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),

    MAIL_DOMAIN: domainList,

    DEFAULT_MAILBOX_TTL_MINUTES: z.coerce.number().int().min(1).default(60),
    MAX_MAILBOX_TTL_MINUTES: z.coerce.number().int().min(1).default(1440),
    MAX_ACTIVE_MAILBOXES: z.coerce.number().int().min(1).default(1000),

    CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
    MESSAGE_RETENTION_HOURS: z.coerce.number().min(0).default(24),
    ATTACHMENT_RETENTION_HOURS: z.coerce.number().min(0).default(24),
    MAILBOX_RETENTION_HOURS: z.coerce.number().min(0).default(24),

    MAX_EMAIL_SIZE_MB: z.coerce.number().positive().default(20),
    MAX_ATTACHMENT_SIZE_MB: z.coerce.number().positive().default(10),
    ATTACHMENT_DIR: z.string().default('./data/attachments'),
    MIGRATIONS_DIR: z.string().optional(),

    MAX_WAIT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

    VERIFICATION_CODE_KEYWORDS: z.string().default(''),
    VERIFICATION_CODE_PATTERNS: z.string().default(''),

    API_AUTH_ENABLED: bool.default(true),
    ADMIN_EMAIL: z.string().email().default('admin@mailtest.local'),
    ADMIN_PASSWORD: z.string().optional(),
    SESSION_TTL_HOURS: z.coerce.number().min(1).default(12),
    COOKIE_SECURE: bool.optional(),
    ALLOWED_ORIGINS: z.string().default(''),

    LOGIN_RATE_LIMIT: rate.default('10/15m'),
    API_RATE_LIMIT: rate.default('1000/hour'),
    MAILBOX_CREATION_RATE_LIMIT: rate.default('100/hour'),
    SEARCH_RATE_LIMIT: rate.default('600/hour'),
    DOWNLOAD_RATE_LIMIT: rate.default('600/hour'),
  })
  .superRefine((env, ctx) => {
    if (env.MAX_MAILBOX_TTL_MINUTES < env.DEFAULT_MAILBOX_TTL_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_MAILBOX_TTL_MINUTES'],
        message: 'must be >= DEFAULT_MAILBOX_TTL_MINUTES',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.API_AUTH_ENABLED) {
        ctx.addIssue({ code: 'custom', path: ['API_AUTH_ENABLED'], message: 'cannot be disabled in production' });
      }
      const pw = env.ADMIN_PASSWORD;
      if (pw !== undefined && (pw.length < 12 || KNOWN_WEAK_PASSWORDS.has(pw))) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_PASSWORD'],
          message: 'must be at least 12 characters and not a well-known default in production',
        });
      }
    }
  });

export type Config = Omit<z.infer<typeof schema>, 'MAIL_DOMAIN' | 'COOKIE_SECURE'> & {
  MAIL_DOMAIN: string[];
  COOKIE_SECURE: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    MAIL_DOMAIN: data.MAIL_DOMAIN as unknown as string[],
    COOKIE_SECURE: data.COOKIE_SECURE ?? data.NODE_ENV === 'production',
  };
}

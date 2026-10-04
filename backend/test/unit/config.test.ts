import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgresql://u:p@db/x', MAIL_DOMAIN: 'mailtest.local' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      DEFAULT_MAILBOX_TTL_MINUTES: 60,
      MAX_MAILBOX_TTL_MINUTES: 1440,
      CLEANUP_INTERVAL_SECONDS: 60,
      API_AUTH_ENABLED: true,
      COOKIE_SECURE: false,
      MAIL_DOMAIN: ['mailtest.local'],
    });
  });

  it('parses multiple domains and normalises case', () => {
    expect(loadConfig({ ...base, MAIL_DOMAIN: 'A.example.com, b.example.com' }).MAIL_DOMAIN).toEqual(['a.example.com', 'b.example.com']);
  });

  it.each([
    [{ MAIL_DOMAIN: 'not a domain' }, /MAIL_DOMAIN/],
    [{ DATABASE_URL: '' }, /DATABASE_URL/],
    [{ MAX_MAILBOX_TTL_MINUTES: '10', DEFAULT_MAILBOX_TTL_MINUTES: '60' }, /MAX_MAILBOX_TTL_MINUTES/],
    [{ LOGIN_RATE_LIMIT: 'often' }, /LOGIN_RATE_LIMIT/],
    [{ APP_PORT: '99999' }, /APP_PORT/],
    [{ API_AUTH_ENABLED: 'maybe' }, /API_AUTH_ENABLED/],
  ])('rejects invalid configuration %j', (override, message) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow(message);
  });

  it('hardens production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', API_AUTH_ENABLED: 'false' })).toThrow(/API_AUTH_ENABLED/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ADMIN_PASSWORD: 'short' })).toThrow(/ADMIN_PASSWORD/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ADMIN_PASSWORD: 'long-enough-password' }).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false', ADMIN_PASSWORD: 'long-enough-password' }).COOKIE_SECURE).toBe(false);
  });
});

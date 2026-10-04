import { describe, expect, it } from 'vitest';
import {
  buildAddress,
  isAllowedDomain,
  normalizePrefix,
  randomSuffix,
  splitAddress,
} from '../../src/lib/mailboxAddress.js';
import { computeExpiry, mailboxStatus, resolveTtlMinutes } from '../../src/lib/ttl.js';
import { parseRateSpec } from '../../src/lib/rateSpec.js';
import { AppError } from '../../src/lib/errors.js';

describe('mailbox addresses', () => {
  it('generates well-formed random addresses', () => {
    const a = buildAddress('signup', randomSuffix(), 'mailtest.local');
    expect(a).toMatch(/^signup-[a-z0-9]{6}@mailtest\.local$/);
    expect(randomSuffix()).not.toBe(randomSuffix());
  });

  it('validates prefixes', () => {
    expect(normalizePrefix(undefined)).toBe('test');
    expect(normalizePrefix(' Checkout ')).toBe('checkout');
    for (const bad of ['', 'a b', '../x', 'x@y', 'a..b', '-a', 'a-', 'x'.repeat(40), "o'brien", 'a;drop table']) {
      expect(normalizePrefix(bad), bad).toBeNull();
    }
  });

  it('validates domains', () => {
    const allowed = ['mailtest.local'];
    expect(isAllowedDomain('A@MailTest.local', allowed)).toBe(true);
    expect(isAllowedDomain('a@evil.com', allowed)).toBe(false);
    expect(isAllowedDomain('a@sub.mailtest.local', allowed)).toBe(false);
    expect(isAllowedDomain('a@mailtest.local.evil.com', allowed)).toBe(false);
    expect(isAllowedDomain('nodomain', allowed)).toBe(false);
    expect(splitAddress('x@y@mailtest.local')).toEqual({ local: 'x@y', domain: 'mailtest.local' });
  });
});

describe('ttl', () => {
  const limits = { default: 60, max: 1440 };
  it('applies defaults and limits', () => {
    expect(resolveTtlMinutes(undefined, limits)).toBe(60);
    expect(resolveTtlMinutes(5, limits)).toBe(5);
    expect(() => resolveTtlMinutes(1441, limits)).toThrow(AppError);
    expect(() => resolveTtlMinutes(0, limits)).toThrow(AppError);
    expect(() => resolveTtlMinutes(1.5, limits)).toThrow(AppError);
  });
  it('computes expiry and status', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const exp = computeExpiry(30, now);
    expect(exp.toISOString()).toBe('2026-01-01T00:30:00.000Z');
    expect(mailboxStatus(exp, new Date('2026-01-01T00:29:59Z'))).toBe('active');
    expect(mailboxStatus(exp, new Date('2026-01-01T00:30:00Z'))).toBe('expired');
  });
});

describe('rate spec', () => {
  it('parses specs', () => {
    expect(parseRateSpec('10/15m')).toEqual({ max: 10, windowMs: 900_000 });
    expect(parseRateSpec('100/hour')).toEqual({ max: 100, windowMs: 3_600_000 });
    expect(parseRateSpec('5/30s')).toEqual({ max: 5, windowMs: 30_000 });
    expect(() => parseRateSpec('lots')).toThrow();
  });
});

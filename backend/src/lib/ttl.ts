import { badRequest } from './errors.js';

export const TTL_PRESETS_MINUTES = [5, 15, 30, 60, 360, 1440] as const;

export function resolveTtlMinutes(requested: number | undefined, defaults: { default: number; max: number }): number {
  const ttl = requested ?? defaults.default;
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw badRequest('INVALID_TTL', 'ttlMinutes must be a positive integer');
  }
  if (ttl > defaults.max) {
    throw badRequest('TTL_TOO_LONG', `ttlMinutes must not exceed ${defaults.max}`);
  }
  return ttl;
}

export function computeExpiry(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

export type MailboxStatus = 'active' | 'expired';

export function mailboxStatus(expiresAt: Date, now: Date = new Date()): MailboxStatus {
  return expiresAt.getTime() > now.getTime() ? 'active' : 'expired';
}

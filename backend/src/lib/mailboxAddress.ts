import { randomBytes } from 'node:crypto';

const PREFIX_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
export const DEFAULT_PREFIX = 'test';
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Normalises and validates a user supplied prefix. Returns null when invalid. */
export function normalizePrefix(input: string | undefined): string | null {
  const prefix = (input ?? DEFAULT_PREFIX).trim().toLowerCase();
  if (!PREFIX_RE.test(prefix) || prefix.includes('..')) return null;
  return prefix;
}

/** Cryptographically random suffix, e.g. "a8f72c". */
export function randomSuffix(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[(bytes[i] as number) % SUFFIX_ALPHABET.length];
  }
  return out;
}

export function buildAddress(prefix: string, suffix: string, domain: string): string {
  return `${prefix}-${suffix}@${domain}`.toLowerCase();
}

/** Splits "local@domain" and lower-cases it. Returns null for anything that is not a plain address. */
export function splitAddress(address: string): { local: string; domain: string } | null {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

export function isAllowedDomain(address: string, allowedDomains: readonly string[]): boolean {
  const parts = splitAddress(address);
  return parts !== null && allowedDomains.includes(parts.domain);
}

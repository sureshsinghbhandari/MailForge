import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';
import { formatBytes, formatCountdown, formatRelative, formatUptime, isHttpUrl, localDateToIso, ttlLabel } from './format';
import { buildMessageQuery, parseListParams } from './messageQuery';
import { sortCodes, sortLinks } from './detected';

describe('formatCountdown', () => {
  it('formats mm:ss under an hour', () => {
    expect(formatCountdown(59 * 60_000 + 42_000)).toBe('59:42');
    expect(formatCountdown(5_000)).toBe('00:05');
  });
  it('formats h:mm:ss under a day and days beyond', () => {
    expect(formatCountdown(3_600_000 + 65_000)).toBe('1:01:05');
    expect(formatCountdown(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 03h');
  });
  it('clamps negative values', () => {
    expect(formatCountdown(-5000)).toBe('00:00');
  });
});

describe('other format helpers', () => {
  it('formats relative times', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(formatRelative('2026-01-01T11:59:58Z', now)).toBe('just now');
    expect(formatRelative('2026-01-01T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-01-01T11:15:00Z', now)).toBe('45m ago');
    expect(formatRelative('2026-01-01T07:00:00Z', now)).toBe('5h ago');
    expect(formatRelative('2025-12-30T12:00:00Z', now)).toBe('2d ago');
  });
  it('formats bytes, uptime and ttl labels', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatUptime(59)).toBe('59s');
    expect(formatUptime(3725)).toBe('1h 2m');
    expect(ttlLabel(5)).toBe('5 minutes');
    expect(ttlLabel(60)).toBe('1 hour');
    expect(ttlLabel(360)).toBe('6 hours');
    expect(ttlLabel(1440)).toBe('24 hours');
    expect(ttlLabel(90)).toBe('90 minutes');
  });
  it('only treats http(s) URLs as openable', () => {
    expect(isHttpUrl('https://example.com/a?b=1')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isHttpUrl('mailto:a@b.c')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
  it('converts local dates to ISO instants', () => {
    expect(localDateToIso('', false)).toBeUndefined();
    const start = new Date(localDateToIso('2026-03-05', false) as string);
    const end = new Date(localDateToIso('2026-03-05', true) as string);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([2026, 2, 5, 0]);
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  });
});

describe('detected ordering', () => {
  it('sorts codes by confidence descending and verification links first', () => {
    const codes = sortCodes([
      { code: 'A', codeType: 'otp', confidence: 0.4 },
      { code: 'B', codeType: 'otp', confidence: 0.95 },
    ]);
    expect(codes.map((c) => c.code)).toEqual(['B', 'A']);
    const links = sortLinks([
      { url: 'https://a', linkType: 'other', isVerification: false },
      { url: 'https://b', linkType: 'verify', isVerification: true },
    ]);
    expect(links.map((l) => l.url)).toEqual(['https://b', 'https://a']);
  });
});

describe('buildMessageQuery', () => {
  it('implements the Today chip with a local-midnight dateFrom instead of the server filter', () => {
    const now = new Date(2026, 5, 15, 14, 30);
    const q = buildMessageQuery(parseListParams(new URLSearchParams('filter=today')), { now });
    expect(q['filter']).toBeUndefined();
    expect(q['dateFrom']).toBe(new Date(2026, 5, 15, 0, 0, 0, 0).toISOString());
  });
  it('passes other filters, search and pagination through', () => {
    const q = buildMessageQuery(parseListParams(new URLSearchParams('filter=unread&q=%20code%20&page=3')), { mailboxId: 'mb1' });
    expect(q).toMatchObject({ filter: 'unread', search: 'code', page: 3, mailboxId: 'mb1', pageSize: 25 });
  });
  it('ignores unknown filters and bad pages', () => {
    const p = parseListParams(new URLSearchParams('filter=bogus&page=-2'));
    expect(p.filter).toBe('all');
    expect(p.page).toBe(1);
  });
});

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to a textarea + execCommand when the API is missing or rejects', async () => {
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true });

    vi.stubGlobal('navigator', {});
    await expect(copyText('fallback one')).resolves.toBe(true);

    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyText('fallback two')).resolves.toBe(true);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure when both paths fail', async () => {
    Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(false), configurable: true, writable: true });
    vi.stubGlobal('navigator', {});
    await expect(copyText('x')).resolves.toBe(false);
  });
});

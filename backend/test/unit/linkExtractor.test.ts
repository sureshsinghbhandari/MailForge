import { describe, expect, it } from 'vitest';
import { extractLinks, pickVerificationUrl } from '../../src/services/linkExtractor.js';

describe('extractLinks', () => {
  it('extracts and classifies links from text and html', () => {
    const links = extractLinks(
      'Verify here: https://example.com/verify?token=abc. Or https://example.com/reset-password/xyz!',
      '<a href="https://example.com/confirm/123">Confirm</a><a href="mailto:x@y.z">mail</a><a href="javascript:alert(1)">x</a>',
    );
    expect(links).toEqual([
      { url: 'https://example.com/confirm/123', linkType: 'confirm' },
      { url: 'https://example.com/verify?token=abc', linkType: 'verify' },
      { url: 'https://example.com/reset-password/xyz', linkType: 'reset_password' },
    ]);
  });

  it.each([
    ['/activate/abc', 'activate'],
    ['/verification/abc', 'verify'],
    ['/password-reset?x=1', 'reset_password'],
    ['/magic-link/abc', 'magic_link'],
    ['/login', 'login'],
    ['/products/1', 'other'],
  ])('classifies %s as %s', (path, type) => {
    expect(extractLinks(`https://a.example${path}`, null)[0]?.linkType).toBe(type);
  });

  it('deduplicates and decodes HTML entities in hrefs', () => {
    const links = extractLinks(
      'https://a.example/verify?a=1&b=2',
      '<a href="https://a.example/verify?a=1&amp;b=2">x</a>',
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe('https://a.example/verify?a=1&b=2');
  });

  it('only accepts http(s)', () => {
    expect(extractLinks('ftp://x.example/a file:///etc/passwd data:text/html,hi', null)).toEqual([]);
  });

  it('keeps balanced parentheses and strips trailing punctuation', () => {
    expect(extractLinks('(see https://a.example/x_(y)) and https://a.example/z.', null).map((l) => l.url)).toEqual([
      'https://a.example/x_(y)',
      'https://a.example/z',
    ]);
  });

  it('picks the best verification url, never plain login', () => {
    expect(pickVerificationUrl(extractLinks('https://a.example/login https://a.example/confirm/1', null))).toBe(
      'https://a.example/confirm/1',
    );
    expect(pickVerificationUrl(extractLinks('https://a.example/login', null))).toBeNull();
  });
});

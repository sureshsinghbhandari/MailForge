import { describe, expect, it } from 'vitest';
import { extractCodes } from '../../src/services/codeExtractor.js';

const codes = (subject: string, text: string, opts = {}) => extractCodes(subject, text, opts).map((c) => c.code);

describe('extractCodes', () => {
  it.each([
    ['Your verification code is 482913', '482913'],
    ['Your OTP is 839204', '839204'],
    ['Code: 173829', '173829'],
    ['Verification PIN: 123456', '123456'],
    ['Your passcode is 98765', '98765'],
    ['Security code: 1234', '1234'],
    ['Authentication code 12345678', '12345678'],
    ['Enter this code to continue:\n\n654321', '654321'],
    ['482913 is your verification code', '482913'],
    ['Use 246810 to verify your account', '246810'],
    ['Your code is 123 456', '123456'],
    ['Your code is 123-456', '123456'],
  ])('detects %j', (text, expected) => {
    expect(codes('', text)).toContain(expected);
  });

  it('reads the subject too', () => {
    expect(codes('Your code: 112233', '')).toEqual(['112233']);
  });

  it.each([
    'Invoice number 20260412 is attached',
    'Your total is $123456.00',
    'Order #884213 has shipped',
    'Call us on +1 555 123 4567',
    'Phone: 555-1234 for support',
    'Date: 12/05/2026',
    'Please verify your order of 1,234 items',
    'Price 4999.99',
    'Hello, welcome to our service. Meeting ID 3827491 at noon',
  ])('ignores %j', (text) => {
    expect(codes('', text)).toEqual([]);
  });

  it('does not treat a year as a code unless introduced directly', () => {
    expect(codes('', 'Your code will expire in 2026 minutes')).toEqual([]);
    expect(codes('', 'Your code is 2024')).toEqual(['2024']);
  });

  it('ignores digits outside the keyword window or across sentences', () => {
    expect(codes('', 'Use the verification link below. Reference 998877')).toEqual([]);
  });

  it('ranks direct matches above looser ones and dedupes', () => {
    const result = extractCodes('', 'Your verification code is 482913. Code: 482913');
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('skips a short number between keyword and code', () => {
    expect(codes('', 'Your code (valid for 10 minutes) is 445566')).toContain('445566');
  });

  it('supports custom keywords and patterns', () => {
    expect(codes('', 'Your ticket-key is 7777', { extraKeywords: ['ticket-key'] })).toContain('7777');
    const custom = extractCodes('', 'Token=AB12-CD34 issued', { extraPatterns: [/token=([A-Z0-9-]+)/i] });
    expect(custom[0]).toMatchObject({ code: 'AB12-CD34', codeType: 'custom' });
  });

  it('copes with huge input', () => {
    const big = 'lorem ipsum '.repeat(100_000) + ' code is 111222';
    expect(() => extractCodes('', big)).not.toThrow();
  });
});

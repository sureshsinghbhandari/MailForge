export interface ExtractedCode {
  code: string;
  codeType: 'numeric' | 'custom';
  /** 0..1 – how sure we are this is a verification code. */
  confidence: number;
}

export interface CodeExtractorOptions {
  /** Additional keywords (case-insensitive, matched literally) that introduce a code. */
  extraKeywords?: string[];
  /** Additional patterns; capture group 1 (or the whole match) is the code. */
  extraPatterns?: RegExp[];
}

const MAX_INPUT_CHARS = 200_000;
const MAX_CODES = 10;
const WINDOW_CHARS = 60;
const MAX_GAP_CHARS = 40;

const BASE_KEYWORDS = [
  'verification code',
  'confirmation code',
  'authentication code',
  'security code',
  'one-time password',
  'one time password',
  'one-time code',
  'one time code',
  'login code',
  'sign-in code',
  'sign in code',
  'auth code',
  'access code',
  'verification pin',
  'verification',
  'verify',
  'passcode',
  'otp',
  'pin',
  'code',
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildKeywordRegex(extra: string[]): RegExp {
  const all = [...extra.map((k) => k.trim()).filter(Boolean), ...BASE_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  // Optional trailing noun so "verification code" is consumed as one keyword.
  return new RegExp(`\\b(?:${all.join('|')})(?:\\s+(?:code|number|pin|password))?\\b`, 'gi');
}

// A code is 4-8 digits, or 3+3 digits split by a space/dash ("123 456").
const CANDIDATE_RE = /(\d{3}[ -]\d{3}(?!\d)|\d{4,8})(?!\d)/y;
const NON_CODE_CONTEXT_BEFORE = /(?:invoice|order|ref(?:erence)?|tracking|ticket|receipt|amount|total|phone|tel|call|account|zip|postcode)\W{0,6}$/i;
const DIRECT_GAP_RE = /^\s*(?:(?:is|are|was|=|:|-|–|—)\s*){0,2}[:\-–—]?\s*$/i;

function isPlausibleCandidate(text: string, start: number, end: number, direct: boolean): boolean {
  const before = text[start - 1] ?? ' ';
  const after = text[end] ?? ' ';
  const after2 = text[end + 1] ?? ' ';
  // Money, hashes/ids, phone numbers, negative numbers, version numbers, URL pieces.
  if (/[$€£¥#+\-/.\\@_a-z0-9]/i.test(before)) return false;
  if (/[a-z0-9%_@]/i.test(after)) return false;
  // Dates / decimals / thousand separators / phone-like continuations: "12/05/2026", "12.50", "1,234", "123-4567".
  if (/[/\\]/.test(after)) return false;
  if (/[.,-]/.test(after) && /\d/.test(after2)) return false;
  if (NON_CODE_CONTEXT_BEFORE.test(text.slice(Math.max(0, start - 20), start))) return false;
  const digits = text.slice(start, end).replace(/\D/g, '');
  // Year-like four digit numbers are only accepted when explicitly introduced ("code is 2024").
  if (digits.length === 4 && /^(?:19|20)\d{2}$/.test(digits) && !direct) return false;
  return true;
}

function normalise(subject: string, text: string): string {
  return `${subject}\n${text}`.slice(0, MAX_INPUT_CHARS).replace(/\s+/g, ' ');
}

export function extractCodes(
  subject: string,
  text: string,
  options: CodeExtractorOptions = {},
): ExtractedCode[] {
  const haystack = normalise(subject, text);
  const found = new Map<string, ExtractedCode>();
  const add = (code: string, codeType: ExtractedCode['codeType'], confidence: number) => {
    const existing = found.get(code);
    if (!existing || existing.confidence < confidence) {
      found.set(code, { code, codeType, confidence: Math.round(confidence * 100) / 100 });
    }
  };

  // 1. keyword followed by a code: "Your verification code is 482913", "OTP: 839204".
  const keywordRe = buildKeywordRegex(options.extraKeywords ?? []);
  for (const kw of haystack.matchAll(keywordRe)) {
    const afterKeyword = kw.index + kw[0].length;
    const windowText = haystack.slice(afterKeyword, afterKeyword + WINDOW_CHARS);
    let skipped = 0;
    for (const run of windowText.matchAll(/\d+/g)) {
      const runStart = afterKeyword + run.index;
      const gap = haystack.slice(afterKeyword, runStart);
      if (gap.length > MAX_GAP_CHARS || /[.!?]\s/.test(gap) || /[.!?]$/.test(gap)) break;
      CANDIDATE_RE.lastIndex = runStart;
      const candidate = CANDIDATE_RE.exec(haystack);
      const direct = DIRECT_GAP_RE.test(gap);
      if (candidate && isPlausibleCandidate(haystack, runStart, runStart + candidate[0].length, direct)) {
        const code = candidate[1]!.replace(/\D/g, '');
        add(code, 'numeric', (direct ? 0.95 : 0.7) - 0.1 * skipped);
        break;
      }
      skipped += 1;
      if (skipped > 2) break;
    }
  }

  // 2. code followed by a phrase: "482913 is your verification code", "Use 482913 to sign in".
  const reverse =
    /(?<![\w$€£#.\-/+])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%/])\s+is\s+your\s+(?:[\w-]+\s+){0,3}?(?:code|otp|pin|passcode)\b/gi;
  for (const m of haystack.matchAll(reverse)) {
    add(m[1]!.replace(/\D/g, ''), 'numeric', 0.9);
  }
  const useTo =
    /\buse\s+(?:code\s+)?(?<![\w$€£#.\-/+])(\d{4,8})(?![\w%/])\s+(?:to|as|for)\s+(?:verify|confirm|sign|log|complete|authenticate|reset)/gi;
  for (const m of haystack.matchAll(useTo)) {
    add(m[1]!, 'numeric', 0.8);
  }

  // 3. operator supplied patterns.
  for (const pattern of options.extraPatterns ?? []) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of haystack.matchAll(re)) {
      const code = (m[1] ?? m[0]).trim();
      if (code) add(code, 'custom', 0.8);
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CODES);
}

/** Parses the VERIFICATION_CODE_PATTERNS env var (JSON array of regex source strings). */
export function parseExtraPatterns(raw: string): RegExp[] {
  if (!raw.trim()) return [];
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && p.length <= 200)) {
    throw new Error('VERIFICATION_CODE_PATTERNS must be a JSON array of regex strings (max 200 chars each)');
  }
  return list.map((p) => new RegExp(p as string, 'i'));
}

export function parseExtraKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

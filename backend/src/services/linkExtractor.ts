import { Parser } from 'htmlparser2';

export type LinkType =
  | 'verify'
  | 'confirm'
  | 'activate'
  | 'magic_link'
  | 'reset_password'
  | 'login'
  | 'unsubscribe'
  | 'other';

export interface ExtractedLink {
  url: string;
  linkType: LinkType;
}

const MAX_LINKS = 100;
const MAX_URL_LENGTH = 2048;
const MAX_INPUT_CHARS = 1_000_000;

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\\^{}|]+/gi;

const RULES: Array<[LinkType, RegExp]> = [
  ['reset_password', /reset[-_]?password|password[-_]?reset|forgot[-_]?password/],
  ['magic_link', /magic[-_]?link/],
  ['verify', /verif(?:y|ication)|validate/],
  ['confirm', /confirm/],
  ['activate', /activat(?:e|ion)/],
  ['login', /log[-_]?in|sign[-_]?in/],
  ['unsubscribe', /unsubscribe|opt[-_]?out/],
];

/** Verification-like link types, in the order a test would want to pick one. */
export const VERIFICATION_PRIORITY: LinkType[] = ['verify', 'confirm', 'activate', 'magic_link', 'reset_password'];
const VERIFICATION_TYPES = new Set<LinkType>([...VERIFICATION_PRIORITY, 'login']);

export function classifyUrl(url: URL): LinkType {
  const haystack = decodeURIComponentSafe(url.pathname).toLowerCase();
  for (const [type, re] of RULES) {
    if (re.test(haystack)) return type;
  }
  return 'other';
}

export function isVerificationLink(type: string): boolean {
  return VERIFICATION_TYPES.has(type as LinkType);
}

/** The single best link for automated flows (never a bare /login or unsubscribe link). */
export function pickVerificationUrl(links: ExtractedLink[]): string | null {
  for (const type of VERIFICATION_PRIORITY) {
    const hit = links.find((l) => l.linkType === type);
    if (hit) return hit.url;
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function trimTrailingPunctuation(url: string): string {
  let out = url;
  while (/[.,;:!?)\]]$/.test(out)) {
    // keep a closing paren that balances an opening one in the URL (e.g. wikipedia links)
    if (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) break;
    out = out.slice(0, -1);
  }
  return out;
}

function normaliseCandidate(raw: string): string | null {
  const candidate = trimTrailingPunctuation(raw.trim());
  if (candidate.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return candidate;
  } catch {
    return null;
  }
}

function hrefsFromHtml(html: string): string[] {
  const hrefs: string[] = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'a' && attrs['href']) hrefs.push(attrs['href']);
    },
  });
  parser.write(html.slice(0, MAX_INPUT_CHARS));
  parser.end();
  return hrefs;
}

export function extractLinks(text: string | null | undefined, html: string | null | undefined): ExtractedLink[] {
  const candidates: string[] = [];
  if (html) candidates.push(...hrefsFromHtml(html));
  if (text) candidates.push(...(text.slice(0, MAX_INPUT_CHARS).match(URL_IN_TEXT) ?? []));

  const seen = new Set<string>();
  const links: ExtractedLink[] = [];
  for (const raw of candidates) {
    const url = normaliseCandidate(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, linkType: classifyUrl(new URL(url)) });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

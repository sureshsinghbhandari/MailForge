import { simpleParser, type AddressObject, type Attachment } from 'mailparser';
import { htmlToText } from './sanitizeHtml.js';

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  content: Buffer;
}

export interface ParsedEmail {
  messageId: string | null;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  date: Date | null;
  text: string | null;
  html: string | null;
  headers: Array<{ name: string; value: string }>;
  attachments: ParsedAttachment[];
  /** Every To/Cc/Bcc address found in the headers, lower-cased. */
  headerRecipients: string[];
}

const MAX_SUBJECT = 500;
const MAX_FILENAME = 200;

/** Strips path components and control characters; never returns an empty name. */
export function sanitizeFilename(name: string | undefined | null, fallback = 'attachment'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILENAME);
  return cleaned || fallback;
}

function formatAddresses(field: AddressObject | AddressObject[] | undefined): string | null {
  if (!field) return null;
  const list = Array.isArray(field) ? field : [field];
  const text = list
    .map((a) => a.text)
    .filter(Boolean)
    .join(', ');
  return text || null;
}

function addressesOf(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((a) => a.value.map((v) => v.address?.toLowerCase()).filter((x): x is string => !!x));
}

function headerValue(line: string): string {
  const idx = line.indexOf(':');
  return (idx === -1 ? line : line.slice(idx + 1)).replace(/\r?\n[ \t]+/g, ' ').trim();
}

/** Header name with its original casing (mailparser's `key` is lower-cased). */
function headerName(line: string, fallback: string): string {
  const idx = line.indexOf(':');
  return idx > 0 ? line.slice(0, idx).trim() : fallback;
}

function cleanContentId(cid: string | undefined): string | null {
  if (!cid) return null;
  return cid.replace(/^<|>$/g, '') || null;
}

/** Parses a raw RFC 5322 message. Rejects only if the input cannot be read at all. */
export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });

  const from = mail.from?.value[0];
  const html = typeof mail.html === 'string' && mail.html.trim() ? mail.html : null;
  const text = mail.text?.trim() ? mail.text : html ? htmlToText(html) : null;

  const attachments = mail.attachments.map((a: Attachment, i: number) => ({
    filename: sanitizeFilename(a.filename, `attachment-${i + 1}`),
    mimeType: (a.contentType || 'application/octet-stream').toLowerCase().slice(0, 200),
    size: a.size ?? a.content.length,
    contentId: cleanContentId(a.cid ?? a.contentId),
    content: a.content,
  }));

  return {
    messageId: nul(mail.messageId) ?? null,
    subject: nul((mail.subject ?? '').slice(0, MAX_SUBJECT)) ?? '',
    fromAddress: (nul(from?.address ?? '') ?? '').toLowerCase() || 'unknown',
    fromName: nul(from?.name) || null,
    toAddress: nul(formatAddresses(mail.to)) ?? '',
    cc: nul(formatAddresses(mail.cc)) ?? null,
    bcc: nul(formatAddresses(mail.bcc)) ?? null,
    replyTo: nul(formatAddresses(mail.replyTo)) ?? null,
    date: mail.date ?? null,
    text: nul(text) ?? null,
    html: nul(html) ?? null,
    headers: mail.headerLines.map((h) => ({ name: nul(headerName(h.line, h.key)) ?? '', value: nul(headerValue(h.line)) ?? '' })),
    attachments,
    headerRecipients: [...addressesOf(mail.to), ...addressesOf(mail.cc), ...addressesOf(mail.bcc)],
  };
}

/** PostgreSQL text/jsonb cannot hold NUL characters, which hostile or corrupt mail can contain. */
function nul<T extends string | null | undefined>(value: T): T {
  // eslint-disable-next-line no-control-regex
  return (typeof value === 'string' ? value.replace(/\u0000/g, '') : value) as T;
}

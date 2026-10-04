import { readFile } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import type { Db } from '../db/types.js';
import { AppError, notFound } from '../lib/errors.js';
import { isUuid } from '../lib/validation.js';
import type { AttachmentStorage } from './attachmentStorage.js';
import type { EventBus } from './eventBus.js';
import { isVerificationLink, pickVerificationUrl, type ExtractedLink, type LinkType } from './linkExtractor.js';
import { escapeLike, type Actor } from './mailboxService.js';
import { sanitizeEmailHtml } from './sanitizeHtml.js';
import { writeAudit } from './audit.js';

export type MessageFilter = 'all' | 'unread' | 'read' | 'attachments' | 'codes' | 'links' | 'today' | 'hour';

export interface MessageListQuery {
  mailboxId?: string | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  code?: string | undefined;
  url?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  filter: MessageFilter;
  page: number;
  pageSize: number;
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  mailboxEmail: string;
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  to: string;
  subject: string;
  preview: string;
  receivedAt: string;
  isRead: boolean;
  size: number;
  attachmentCount: number;
  linkCount: number;
  codeCount: number;
}

export interface CodeView {
  code: string;
  codeType: string;
  confidence: number;
}

export interface LinkView {
  url: string;
  linkType: LinkType | string;
  isVerification: boolean;
}

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  stored: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  text: string | null;
  /** Sanitised HTML fragment; null when the message has no HTML part. Never the raw HTML. */
  html: string | null;
  headers: Array<{ name: string; value: string }>;
  attachments: AttachmentView[];
  codes: CodeView[];
  links: LinkView[];
  verificationCode: string | null;
  verificationUrl: string | null;
}

interface SummaryRow {
  id: string;
  mailbox_id: string;
  mailbox_address: string;
  message_id: string | null;
  from_address: string;
  from_name: string | null;
  to_address: string;
  subject: string;
  preview: string;
  received_at: Date;
  is_read: boolean;
  size: number;
  attachment_count: number;
  link_count: number;
  code_count: number;
}

const SUMMARY_COLUMNS = `m.id, m.mailbox_id, mb.address AS mailbox_address, m.message_id, m.from_address, m.from_name,
  m.to_address, m.subject, m.preview, m.received_at, m.is_read, m.size, m.attachment_count, m.link_count, m.code_count`;

const MAX_INLINE_IMAGE_BYTES = 1_000_000;
const MAX_INLINE_TOTAL_BYTES = 5_000_000;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function toSummary(r: SummaryRow): MessageSummary {
  return {
    id: r.id,
    mailboxId: r.mailbox_id,
    mailboxEmail: r.mailbox_address,
    messageId: r.message_id,
    fromAddress: r.from_address,
    fromName: r.from_name,
    to: r.to_address,
    subject: r.subject,
    preview: r.preview,
    receivedAt: r.received_at.toISOString(),
    isRead: r.is_read,
    size: r.size,
    attachmentCount: r.attachment_count,
    linkCount: r.link_count,
    codeCount: r.code_count,
  };
}

export class MessageService {
  constructor(
    private readonly db: Db,
    private readonly storage: AttachmentStorage,
    private readonly events: EventBus,
  ) {}

  async list(query: MessageListQuery) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const like = (value: string) => add(`%${escapeLike(value)}%`);

    if (query.mailboxId) where.push(`m.mailbox_id = ${add(query.mailboxId)}`);
    if (query.from) {
      const p = like(query.from);
      where.push(`(m.from_address ILIKE ${p} OR m.from_name ILIKE ${p})`);
    }
    if (query.to) where.push(`(m.to_address ILIKE ${like(query.to)} OR mb.address ILIKE ${like(query.to)})`);
    if (query.subject) where.push(`m.subject ILIKE ${like(query.subject)}`);
    if (query.code) {
      where.push(`EXISTS (SELECT 1 FROM verification_codes c WHERE c.message_id = m.id AND c.code = ${add(query.code)})`);
    }
    if (query.url) {
      where.push(`EXISTS (SELECT 1 FROM message_links l WHERE l.message_id = m.id AND l.url ILIKE ${like(query.url)})`);
    }
    if (query.dateFrom) where.push(`m.received_at >= ${add(query.dateFrom)}`);
    if (query.dateTo) where.push(`m.received_at <= ${add(query.dateTo)}`);
    if (query.search) {
      const p = like(query.search);
      where.push(`(
        m.from_address ILIKE ${p} OR m.from_name ILIKE ${p} OR m.to_address ILIKE ${p} OR mb.address ILIKE ${p}
        OR m.subject ILIKE ${p} OR m.text_body ILIKE ${p}
        OR EXISTS (SELECT 1 FROM verification_codes c WHERE c.message_id = m.id AND c.code ILIKE ${p})
        OR EXISTS (SELECT 1 FROM message_links l WHERE l.message_id = m.id AND l.url ILIKE ${p})
      )`);
    }
    switch (query.filter) {
      case 'unread':
        where.push('NOT m.is_read');
        break;
      case 'read':
        where.push('m.is_read');
        break;
      case 'attachments':
        where.push('m.attachment_count > 0');
        break;
      case 'codes':
        where.push('m.code_count > 0');
        break;
      case 'links':
        where.push('m.link_count > 0');
        break;
      case 'today':
        where.push("m.received_at >= date_trunc('day', now())");
        break;
      case 'hour':
        where.push("m.received_at >= now() - interval '1 hour'");
        break;
      case 'all':
        break;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id';
    const total = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n ${from} ${whereSql}`, params);
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const rows = await this.db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} ${from} ${whereSql} ORDER BY m.received_at DESC, m.id LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows.rows.map(toSummary), total: total.rows[0]?.n ?? 0 };
  }

  async get(id: string): Promise<MessageDetail> {
    this.assertId(id);
    const res = await this.db.query<
      SummaryRow & {
        cc: string | null;
        bcc: string | null;
        reply_to: string | null;
        text_body: string | null;
        html_body: string | null;
        headers: Array<{ name: string; value: string }>;
      }
    >(
      `SELECT ${SUMMARY_COLUMNS}, m.cc, m.bcc, m.reply_to, m.text_body, m.html_body, m.headers
         FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');

    const [attachments, codes, links] = await Promise.all([
      this.listAttachmentRows(id),
      this.getCodes(id),
      this.getLinks(id),
    ]);

    const html = await this.sanitiseBody(row.html_body, attachments);

    const extracted: ExtractedLink[] = links.map((l) => ({ url: l.url, linkType: l.linkType as LinkType }));
    return {
      ...toSummary(row),
      cc: row.cc,
      bcc: row.bcc,
      replyTo: row.reply_to,
      text: row.text_body,
      html,
      headers: row.headers,
      attachments: attachments.map(toAttachmentView),
      codes,
      links,
      verificationCode: codes[0]?.code ?? null,
      verificationUrl: pickVerificationUrl(extracted),
    };
  }

  /** Sanitised HTML fragment for a message, or null when it has no HTML part. */
  async getSanitisedHtml(id: string): Promise<string | null> {
    this.assertId(id);
    const res = await this.db.query<{ html_body: string | null }>('SELECT html_body FROM messages WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
    return this.sanitiseBody(row.html_body, await this.listAttachmentRows(id));
  }

  private async sanitiseBody(htmlBody: string | null, attachments: AttachmentRow[]): Promise<string | null> {
    if (!htmlBody) return null;
    const inlineImages = /cid:/i.test(htmlBody) ? await this.loadInlineImages(attachments) : {};
    return sanitizeEmailHtml(htmlBody, { inlineImages });
  }

  async getCodes(id: string): Promise<CodeView[]> {
    this.assertId(id);
    await this.assertExists(id);
    const res = await this.db.query<{ code: string; code_type: string; confidence: number }>(
      'SELECT code, code_type, confidence FROM verification_codes WHERE message_id = $1 ORDER BY position',
      [id],
    );
    return res.rows.map((r) => ({ code: r.code, codeType: r.code_type, confidence: Math.round(r.confidence * 100) / 100 }));
  }

  async getLinks(id: string): Promise<LinkView[]> {
    this.assertId(id);
    await this.assertExists(id);
    const res = await this.db.query<{ url: string; link_type: string }>(
      'SELECT url, link_type FROM message_links WHERE message_id = $1 ORDER BY position',
      [id],
    );
    return res.rows.map((r) => ({ url: r.url, linkType: r.link_type, isVerification: isVerificationLink(r.link_type) }));
  }

  async getRaw(id: string): Promise<Buffer> {
    this.assertId(id);
    const res = await this.db.query<{ raw_email: Buffer }>('SELECT raw_email FROM messages WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
    return Buffer.from(row.raw_email);
  }

  async listAttachments(id: string): Promise<AttachmentView[]> {
    this.assertId(id);
    await this.assertExists(id);
    return (await this.listAttachmentRows(id)).map(toAttachmentView);
  }

  async openAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; size: number; stream: ReadStream }> {
    this.assertId(messageId);
    if (!isUuid(attachmentId)) throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    const res = await this.db.query<AttachmentRow>(
      `SELECT id, filename, mime_type, size, content_id, storage_path
         FROM attachments WHERE id = $1 AND message_id = $2`,
      [attachmentId, messageId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    if (!row.storage_path) {
      throw new AppError(410, 'ATTACHMENT_NOT_STORED', 'Attachment was not stored (too large or past retention)');
    }
    return { filename: row.filename, mimeType: row.mime_type, size: row.size, stream: this.storage.open(row.storage_path) };
  }

  async setRead(id: string, isRead: boolean): Promise<void> {
    this.assertId(id);
    const res = await this.db.query('UPDATE messages SET is_read = $2 WHERE id = $1', [id, isRead]);
    if (res.rowCount === 0) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }

  async delete(id: string, actor: Actor): Promise<void> {
    this.assertId(id);
    const { mailboxId, paths } = await this.db.tx(async (q) => {
      const msg = await q.query<{ mailbox_id: string }>('SELECT mailbox_id FROM messages WHERE id = $1 FOR UPDATE', [id]);
      const row = msg.rows[0];
      if (!row) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
      const files = await q.query<{ storage_path: string | null }>(
        'SELECT storage_path FROM attachments WHERE message_id = $1',
        [id],
      );
      await q.query('DELETE FROM messages WHERE id = $1', [id]);
      await writeAudit(q, { userId: actor.userId, action: 'message.delete', resourceType: 'message', resourceId: id });
      return { mailboxId: row.mailbox_id, paths: files.rows.map((r) => r.storage_path) };
    });
    await this.storage.removeMany(paths);
    this.events.publish({ type: 'MESSAGE_DELETED', mailboxId, messageId: id });
  }

  private assertId(id: string): void {
    if (!isUuid(id)) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }

  private async assertExists(id: string): Promise<void> {
    const res = await this.db.query('SELECT 1 FROM messages WHERE id = $1', [id]);
    if (res.rowCount === 0) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }

  private async listAttachmentRows(messageId: string): Promise<AttachmentRow[]> {
    const res = await this.db.query<AttachmentRow>(
      `SELECT id, filename, mime_type, size, content_id, storage_path
         FROM attachments WHERE message_id = $1 ORDER BY position`,
      [messageId],
    );
    return res.rows;
  }

  /** Embedded images referenced by cid: become data: URIs so a sandboxed, origin-less iframe can show them. */
  private async loadInlineImages(attachments: AttachmentRow[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let total = 0;
    for (const a of attachments) {
      if (!a.content_id || !a.storage_path || !INLINE_IMAGE_TYPES.has(a.mime_type)) continue;
      if (a.size > MAX_INLINE_IMAGE_BYTES || total + a.size > MAX_INLINE_TOTAL_BYTES) continue;
      try {
        const bytes = await readFile(this.storage.resolve(a.storage_path));
        total += bytes.length;
        out[a.content_id] = `data:${a.mime_type};base64,${bytes.toString('base64')}`;
      } catch {
        // Missing file: leave the image out rather than failing the whole message view.
      }
    }
    return out;
  }
}

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  storage_path: string | null;
}

function toAttachmentView(r: AttachmentRow): AttachmentView {
  return { id: r.id, filename: r.filename, mimeType: r.mime_type, size: r.size, stored: r.storage_path !== null };
}

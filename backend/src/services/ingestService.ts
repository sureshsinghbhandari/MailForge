import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import type { Logger } from '../logger.js';
import { isAllowedDomain } from '../lib/mailboxAddress.js';
import type { AttachmentStorage } from './attachmentStorage.js';
import { extractCodes, parseExtraKeywords, parseExtraPatterns, type CodeExtractorOptions } from './codeExtractor.js';
import type { EventBus } from './eventBus.js';
import { extractLinks } from './linkExtractor.js';
import type { MailboxService } from './mailboxService.js';
import { parseEmail, type ParsedEmail } from './parseEmail.js';
import { htmlToText } from './sanitizeHtml.js';

export interface IncomingEmail {
  raw: Buffer;
  /** Identifier in the SMTP capture server; makes ingestion idempotent per mailbox. */
  sourceId: string | null;
  /** SMTP envelope recipients (RCPT TO), which include Bcc addresses absent from the headers. */
  envelopeRecipients: string[];
}

export type SkipReason = 'too_large' | 'no_matching_mailbox';

export interface IngestOutcome {
  stored: Array<{ messageId: string; mailboxId: string }>;
  skipped?: SkipReason;
}

const PREVIEW_CHARS = 200;

export class IngestService {
  private readonly codeOptions: CodeExtractorOptions;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly mailboxes: MailboxService,
    private readonly storage: AttachmentStorage,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {
    this.codeOptions = {
      extraKeywords: parseExtraKeywords(config.VERIFICATION_CODE_KEYWORDS),
      extraPatterns: parseExtraPatterns(config.VERIFICATION_CODE_PATTERNS),
    };
  }

  /**
   * SMTP receive -> parse -> validate recipients -> store -> extract -> publish.
   * Only addresses in the configured domains that belong to an active mailbox are accepted;
   * everything else is dropped. Nothing is ever forwarded anywhere.
   */
  async ingest(email: IncomingEmail): Promise<IngestOutcome> {
    const maxBytes = this.config.MAX_EMAIL_SIZE_MB * 1024 * 1024;
    if (email.raw.length > maxBytes) {
      this.log.warn({ sourceId: email.sourceId, size: email.raw.length }, 'message exceeds MAX_EMAIL_SIZE_MB, dropped');
      return { stored: [], skipped: 'too_large' };
    }

    const parsed = await this.safeParse(email);
    const candidates = new Set<string>();
    for (const address of [...email.envelopeRecipients, ...parsed.headerRecipients]) {
      const lower = address.trim().toLowerCase();
      if (isAllowedDomain(lower, this.config.MAIL_DOMAIN)) candidates.add(lower);
    }
    const targets = await this.mailboxes.findActiveByAddresses(this.db, [...candidates]);
    if (targets.length === 0) return { stored: [], skipped: 'no_matching_mailbox' };

    const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');
    const codes = extractCodes(parsed.subject, text, this.codeOptions);
    const links = extractLinks(text, parsed.html);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
    const maxAttachment = this.config.MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;

    const stored: IngestOutcome['stored'] = [];
    for (const mailbox of targets) {
      const written: string[] = [];
      try {
        const attachmentPaths: Array<string | null> = [];
        for (const a of parsed.attachments) {
          if (a.size > maxAttachment) {
            this.log.warn({ size: a.size }, 'attachment exceeds MAX_ATTACHMENT_SIZE_MB, not stored');
            attachmentPaths.push(null);
          } else {
            const p = await this.storage.save(a.content);
            written.push(p);
            attachmentPaths.push(p);
          }
        }

        const messageId = await this.db.tx(async (q) => {
          const inserted = await q.query<{ id: string }>(
            `INSERT INTO messages (mailbox_id, source_id, message_id, from_address, from_name, to_address, cc, bcc,
                                   reply_to, subject, text_body, html_body, raw_email, headers, size, preview,
                                   attachment_count, link_count, code_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)
             ON CONFLICT (mailbox_id, source_id) WHERE source_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [
              mailbox.id,
              email.sourceId,
              parsed.messageId,
              parsed.fromAddress,
              parsed.fromName,
              parsed.toAddress || mailbox.address,
              parsed.cc,
              parsed.bcc,
              parsed.replyTo,
              parsed.subject,
              parsed.text,
              parsed.html,
              email.raw,
              JSON.stringify(parsed.headers),
              email.raw.length,
              preview,
              parsed.attachments.length,
              links.length,
              codes.length,
            ],
          );
          const id = inserted.rows[0]?.id;
          if (!id) return null; // already ingested
          for (const [i, a] of parsed.attachments.entries()) {
            await q.query(
              `INSERT INTO attachments (message_id, filename, mime_type, size, content_id, storage_path, position)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [id, a.filename, a.mimeType, a.size, a.contentId, attachmentPaths[i] ?? null, i],
            );
          }
          for (const [i, l] of links.entries()) {
            await q.query('INSERT INTO message_links (message_id, url, link_type, position) VALUES ($1,$2,$3,$4)', [
              id,
              l.url,
              l.linkType,
              i,
            ]);
          }
          for (const [i, c] of codes.entries()) {
            await q.query(
              'INSERT INTO verification_codes (message_id, code, code_type, confidence, position) VALUES ($1,$2,$3,$4,$5)',
              [id, c.code, c.codeType, c.confidence, i],
            );
          }
          return id;
        });

        if (messageId === null) {
          await this.storage.removeMany(written);
          continue;
        }
        stored.push({ messageId, mailboxId: mailbox.id });
        this.events.publish({
          type: 'EMAIL_RECEIVED',
          mailboxId: mailbox.id,
          messageId,
          from: parsed.fromAddress,
          subject: parsed.subject,
          receivedAt: new Date().toISOString(),
        });
      } catch (err) {
        await this.storage.removeMany(written);
        throw err;
      }
    }
    return { stored };
  }

  /** Malformed mail must never crash ingestion: fall back to a minimal record built from the envelope. */
  private async safeParse(email: IncomingEmail): Promise<ParsedEmail> {
    try {
      return await parseEmail(email.raw);
    } catch (err) {
      this.log.error({ err: err instanceof Error ? err.message : String(err), sourceId: email.sourceId }, 'MIME parse failed');
      return {
        messageId: null,
        subject: '(unparseable message)',
        fromAddress: 'unknown',
        fromName: null,
        toAddress: '',
        cc: null,
        bcc: null,
        replyTo: null,
        date: null,
        text: null,
        html: null,
        headers: [],
        attachments: [],
        headerRecipients: [],
      };
    }
  }
}

import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/types.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { buildAddress, normalizePrefix, randomSuffix } from '../lib/mailboxAddress.js';
import { computeExpiry, mailboxStatus, resolveTtlMinutes, type MailboxStatus } from '../lib/ttl.js';
import { isUuid } from '../lib/validation.js';
import { writeAudit } from './audit.js';
import type { AttachmentStorage } from './attachmentStorage.js';
import type { EventBus } from './eventBus.js';

export interface MailboxView {
  id: string;
  email: string;
  prefix: string;
  domain: string;
  status: MailboxStatus;
  expiresAt: string;
  createdAt: string;
  messageCount: number;
  unreadCount: number;
}

interface MailboxRow {
  id: string;
  address: string;
  prefix: string;
  domain: string;
  expires_at: Date;
  created_at: Date;
  message_count?: number;
  unread_count?: number;
}

export interface CreateMailboxInput {
  prefix?: string | undefined;
  ttlMinutes?: number | undefined;
  domain?: string | undefined;
}

export interface Actor {
  userId: string | null;
}

const COUNTS_SQL = `
  (SELECT count(*) FROM messages m WHERE m.mailbox_id = mb.id)::int AS message_count,
  (SELECT count(*) FROM messages m WHERE m.mailbox_id = mb.id AND NOT m.is_read)::int AS unread_count`;

function toView(row: MailboxRow, now = new Date()): MailboxView {
  return {
    id: row.id,
    email: row.address,
    prefix: row.prefix,
    domain: row.domain,
    status: mailboxStatus(row.expires_at, now),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    messageCount: row.message_count ?? 0,
    unreadCount: row.unread_count ?? 0,
  };
}

export class MailboxService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly storage: AttachmentStorage,
    private readonly events: EventBus,
  ) {}

  async create(input: CreateMailboxInput, actor: Actor): Promise<MailboxView> {
    const prefix = normalizePrefix(input.prefix);
    if (!prefix) {
      throw badRequest(
        'INVALID_PREFIX',
        'prefix must be 1-32 characters: lowercase letters, digits, ".", "_" or "-", starting and ending with a letter or digit',
      );
    }
    const ttl = resolveTtlMinutes(input.ttlMinutes, {
      default: this.config.DEFAULT_MAILBOX_TTL_MINUTES,
      max: this.config.MAX_MAILBOX_TTL_MINUTES,
    });
    const domain = (input.domain ?? this.config.MAIL_DOMAIN[0]) as string;
    if (!this.config.MAIL_DOMAIN.includes(domain.toLowerCase())) {
      throw badRequest('DOMAIN_NOT_ALLOWED', `domain must be one of: ${this.config.MAIL_DOMAIN.join(', ')}`);
    }

    const active = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mailboxes WHERE expires_at > now()',
    );
    if ((active.rows[0]?.n ?? 0) >= this.config.MAX_ACTIVE_MAILBOXES) {
      throw new AppError(409, 'MAILBOX_LIMIT_REACHED', 'Maximum number of active mailboxes reached');
    }

    const expiresAt = computeExpiry(ttl);
    for (let attempt = 0; attempt < 5; attempt++) {
      const address = buildAddress(prefix, randomSuffix(), domain.toLowerCase());
      const res = await this.db.query<MailboxRow>(
        `INSERT INTO mailboxes (address, prefix, domain, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (address) DO NOTHING
         RETURNING id, address, prefix, domain, expires_at, created_at`,
        [address, prefix, domain.toLowerCase(), expiresAt, actor.userId],
      );
      const row = res.rows[0];
      if (row) {
        await writeAudit(this.db, {
          userId: actor.userId,
          action: 'mailbox.create',
          resourceType: 'mailbox',
          resourceId: row.id,
          metadata: { ttlMinutes: ttl },
        });
        this.events.publish({ type: 'MAILBOX_CREATED', mailboxId: row.id, address: row.address });
        return toView(row);
      }
    }
    throw new AppError(500, 'ADDRESS_GENERATION_FAILED', 'Could not generate a unique mailbox address');
  }

  async list(opts: { status?: MailboxStatus | undefined; page: number; pageSize: number; search?: string | undefined }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status === 'active') where.push('mb.expires_at > now()');
    if (opts.status === 'expired') where.push('mb.expires_at <= now()');
    if (opts.search) {
      params.push(`%${escapeLike(opts.search)}%`);
      where.push(`mb.address ILIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mailboxes mb ${whereSql}`, params);
    params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
    const rows = await this.db.query<MailboxRow>(
      `SELECT mb.id, mb.address, mb.prefix, mb.domain, mb.expires_at, mb.created_at, ${COUNTS_SQL}
         FROM mailboxes mb ${whereSql}
         ORDER BY mb.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const now = new Date();
    return { items: rows.rows.map((r) => toView(r, now)), total: total.rows[0]?.n ?? 0 };
  }

  async get(id: string): Promise<MailboxView> {
    if (!isUuid(id)) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    const res = await this.db.query<MailboxRow>(
      `SELECT mb.id, mb.address, mb.prefix, mb.domain, mb.expires_at, mb.created_at, ${COUNTS_SQL}
         FROM mailboxes mb WHERE mb.id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    return toView(row);
  }

  /** Active mailboxes for the given (lower-cased) addresses; expired mailboxes never receive mail. */
  async findActiveByAddresses(q: Queryable, addresses: string[]): Promise<Array<{ id: string; address: string }>> {
    if (addresses.length === 0) return [];
    const res = await q.query<{ id: string; address: string }>(
      'SELECT id, address FROM mailboxes WHERE address = ANY($1::text[]) AND expires_at > now()',
      [addresses],
    );
    return res.rows;
  }

  async delete(id: string, actor: Actor): Promise<void> {
    if (!isUuid(id)) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    const paths = await this.db.tx(async (q) => {
      const exists = await q.query('SELECT 1 FROM mailboxes WHERE id = $1 FOR UPDATE', [id]);
      if (exists.rowCount === 0) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
      const files = await q.query<{ storage_path: string | null }>(
        `SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_id = $1`,
        [id],
      );
      await q.query('DELETE FROM mailboxes WHERE id = $1', [id]);
      await writeAudit(q, { userId: actor.userId, action: 'mailbox.delete', resourceType: 'mailbox', resourceId: id });
      return files.rows.map((r) => r.storage_path);
    });
    await this.storage.removeMany(paths);
    this.events.publish({ type: 'MAILBOX_DELETED', mailboxId: id });
  }

  /** Immediately deletes every mailbox past its expiry (no retention grace period). */
  async deleteExpired(actor: Actor): Promise<number> {
    const { ids, paths } = await this.db.tx(async (q) => {
      const expired = await q.query<{ id: string }>('SELECT id FROM mailboxes WHERE expires_at <= now() FOR UPDATE');
      const idList = expired.rows.map((r) => r.id);
      if (idList.length === 0) return { ids: [] as string[], paths: [] as Array<string | null> };
      const files = await q.query<{ storage_path: string | null }>(
        `SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_id = ANY($1::uuid[])`,
        [idList],
      );
      await q.query('DELETE FROM mailboxes WHERE id = ANY($1::uuid[])', [idList]);
      await writeAudit(q, {
        userId: actor.userId,
        action: 'mailbox.delete_expired',
        resourceType: 'mailbox',
        metadata: { count: idList.length },
      });
      return { ids: idList, paths: files.rows.map((r) => r.storage_path) };
    });
    await this.storage.removeMany(paths);
    for (const id of ids) this.events.publish({ type: 'MAILBOX_DELETED', mailboxId: id });
    return ids.length;
  }

  async deleteAllMessages(id: string, actor: Actor): Promise<number> {
    if (!isUuid(id)) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    const { count, paths } = await this.db.tx(async (q) => {
      const exists = await q.query('SELECT 1 FROM mailboxes WHERE id = $1 FOR UPDATE', [id]);
      if (exists.rowCount === 0) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
      const files = await q.query<{ storage_path: string | null }>(
        `SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.mailbox_id = $1`,
        [id],
      );
      const del = await q.query('DELETE FROM messages WHERE mailbox_id = $1', [id]);
      await writeAudit(q, {
        userId: actor.userId,
        action: 'mailbox.clear_messages',
        resourceType: 'mailbox',
        resourceId: id,
        metadata: { count: del.rowCount },
      });
      return { count: del.rowCount, paths: files.rows.map((r) => r.storage_path) };
    });
    await this.storage.removeMany(paths);
    this.events.publish({ type: 'MESSAGES_CLEARED', mailboxId: id });
    return count;
  }
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

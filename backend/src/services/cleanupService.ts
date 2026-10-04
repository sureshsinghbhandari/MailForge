import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import type { Logger } from '../logger.js';
import { writeAudit } from './audit.js';
import type { AttachmentStorage } from './attachmentStorage.js';
import type { AuthService } from './authService.js';
import type { EventBus } from './eventBus.js';

export interface CleanupResult {
  mailboxesDeleted: number;
  messagesDeleted: number;
  attachmentFilesDeleted: number;
  sessionsDeleted: number;
  ranAt: string;
  durationMs: number;
}

const HOUR_MS = 3_600_000;

/**
 * Retention rules (all relative to "now"):
 *  - mailboxes expire at `expires_at`; they are permanently deleted (with messages and attachments)
 *    MAILBOX_RETENTION_HOURS after that (0 = delete as soon as they expire);
 *  - messages are deleted MESSAGE_RETENTION_HOURS after they were received;
 *  - attachment files are deleted ATTACHMENT_RETENTION_HOURS after they were stored (the message stays).
 */
export class CleanupService {
  public lastResult: CleanupResult | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly storage: AttachmentStorage,
    private readonly auth: AuthService,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  async run(now: Date = new Date()): Promise<CleanupResult> {
    const started = Date.now();
    const cutoff = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);

    // 1. Expired mailboxes past their grace period, with their messages + attachments.
    const expiredMailboxes = await this.db.tx(async (q) => {
      const rows = await q.query<{ id: string }>(
        'SELECT id FROM mailboxes WHERE expires_at <= $1 FOR UPDATE',
        [cutoff(this.config.MAILBOX_RETENTION_HOURS)],
      );
      const ids = rows.rows.map((r) => r.id);
      if (ids.length === 0) return { ids, paths: [] as Array<string | null>, messages: 0 };
      const files = await q.query<{ storage_path: string | null }>(
        `SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE m.mailbox_id = ANY($1::uuid[])`,
        [ids],
      );
      const msgs = await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM messages WHERE mailbox_id = ANY($1::uuid[])',
        [ids],
      );
      await q.query('DELETE FROM mailboxes WHERE id = ANY($1::uuid[])', [ids]);
      return { ids, paths: files.rows.map((r) => r.storage_path), messages: msgs.rows[0]?.n ?? 0 };
    });
    let filesDeleted = await this.storage.removeMany(expiredMailboxes.paths);
    for (const id of expiredMailboxes.ids) this.events.publish({ type: 'MAILBOX_DELETED', mailboxId: id });

    // 2. Messages past MESSAGE_RETENTION_HOURS.
    const oldMessages = await this.db.tx(async (q) => {
      const files = await q.query<{ storage_path: string | null }>(
        `SELECT a.storage_path FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE m.received_at < $1`,
        [cutoff(this.config.MESSAGE_RETENTION_HOURS)],
      );
      const del = await q.query('DELETE FROM messages WHERE received_at < $1', [
        cutoff(this.config.MESSAGE_RETENTION_HOURS),
      ]);
      return { count: del.rowCount, paths: files.rows.map((r) => r.storage_path) };
    });
    filesDeleted += await this.storage.removeMany(oldMessages.paths);

    // 3. Attachment files past ATTACHMENT_RETENTION_HOURS (rows are kept, marked as not stored).
    const oldAttachments = await this.db.tx(async (q) => {
      const rows = await q.query<{ id: string; storage_path: string }>(
        'SELECT id, storage_path FROM attachments WHERE storage_path IS NOT NULL AND created_at < $1',
        [cutoff(this.config.ATTACHMENT_RETENTION_HOURS)],
      );
      if (rows.rows.length > 0) {
        await q.query('UPDATE attachments SET storage_path = NULL WHERE id = ANY($1::uuid[])', [
          rows.rows.map((r) => r.id),
        ]);
      }
      return rows.rows.map((r) => r.storage_path);
    });
    filesDeleted += await this.storage.removeMany(oldAttachments);

    const sessionsDeleted = await this.auth.deleteExpiredSessions();

    const result: CleanupResult = {
      mailboxesDeleted: expiredMailboxes.ids.length,
      messagesDeleted: expiredMailboxes.messages + oldMessages.count,
      attachmentFilesDeleted: filesDeleted,
      sessionsDeleted,
      ranAt: now.toISOString(),
      durationMs: Date.now() - started,
    };
    this.lastResult = result;

    if (result.mailboxesDeleted || result.messagesDeleted || result.attachmentFilesDeleted) {
      this.log.info(result, 'cleanup removed expired data');
      await writeAudit(this.db, {
        userId: null,
        action: 'cleanup.run',
        resourceType: 'system',
        metadata: { ...result },
      });
    }
    return result;
  }
}

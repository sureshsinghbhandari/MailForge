import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { isUuid } from '../lib/validation.js';
import type { EventBus } from './eventBus.js';
import { escapeLike } from './mailboxService.js';
import type { MessageService } from './messageService.js';

export interface WaitCriteria {
  mailboxId: string;
  subject?: string | undefined;
  /** POSIX regular expression, evaluated by PostgreSQL (case-insensitive), so it cannot stall the Node event loop. */
  subjectRegex?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  messageId?: string | undefined;
  /** Only messages received strictly after this instant. */
  receivedAfter?: Date | undefined;
  timeoutMs: number;
}

export interface WaitResult {
  received: boolean;
  messageId?: string;
  mailboxId?: string;
  from?: string;
  to?: string;
  subject?: string;
  receivedAt?: string;
  verificationCode?: string | null;
  verificationCodes?: string[];
  verificationUrl?: string | null;
  links?: string[];
}

const FALLBACK_POLL_MS = 2000;

export class WaitService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly events: EventBus,
    private readonly messages: MessageService,
  ) {}

  async waitForEmail(criteria: WaitCriteria, signal?: AbortSignal): Promise<WaitResult> {
    if (!isUuid(criteria.mailboxId)) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    const mailbox = await this.db.query('SELECT 1 FROM mailboxes WHERE id = $1', [criteria.mailboxId]);
    if (mailbox.rowCount === 0) throw notFound('MAILBOX_NOT_FOUND', 'Mailbox not found');
    await this.validateRegex(criteria.subjectRegex);

    const timeoutMs = Math.min(criteria.timeoutMs, this.config.MAX_WAIT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    let wake: (() => void) | undefined;
    const state = { arrived: false };
    const unsubscribe = this.events.subscribe((e) => {
      if (e.type === 'EMAIL_RECEIVED' && e.mailboxId === criteria.mailboxId) {
        state.arrived = true;
        wake?.();
      }
    });
    try {
      for (;;) {
        state.arrived = false;
        const id = await this.findMatch(criteria);
        if (id) return this.buildResult(id);
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) return { received: false };
        if (state.arrived) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(remaining, FALLBACK_POLL_MS));
          function done() {
            clearTimeout(timer);
            wake = undefined;
            signal?.removeEventListener('abort', done);
            resolve();
          }
          wake = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      unsubscribe();
    }
  }

  /** Newest message in the mailbox matching every supplied criterion. */
  private async findMatch(c: WaitCriteria): Promise<string | null> {
    const where = ['m.mailbox_id = $1'];
    const params: unknown[] = [c.mailboxId];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (c.subject) where.push(`m.subject ILIKE ${add(`%${escapeLike(c.subject)}%`)}`);
    if (c.subjectRegex) where.push(`m.subject ~* ${add(c.subjectRegex)}`);
    if (c.from) {
      const p = add(`%${escapeLike(c.from)}%`);
      where.push(`(m.from_address ILIKE ${p} OR m.from_name ILIKE ${p})`);
    }
    if (c.to) where.push(`m.to_address ILIKE ${add(`%${escapeLike(c.to)}%`)}`);
    if (c.messageId) where.push(`m.message_id = ${add(c.messageId)}`);
    if (c.receivedAfter) where.push(`m.received_at > ${add(c.receivedAfter)}`);
    const res = await this.db.query<{ id: string }>(
      `SELECT m.id FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.received_at DESC, m.id LIMIT 1`,
      params,
    );
    return res.rows[0]?.id ?? null;
  }

  private async buildResult(id: string): Promise<WaitResult> {
    const m = await this.messages.get(id);
    return {
      received: true,
      messageId: m.id,
      mailboxId: m.mailboxId,
      from: m.fromAddress,
      to: m.to,
      subject: m.subject,
      receivedAt: m.receivedAt,
      verificationCode: m.verificationCode,
      verificationCodes: m.codes.map((c) => c.code),
      verificationUrl: m.verificationUrl,
      links: m.links.map((l) => l.url),
    };
  }

  private async validateRegex(pattern: string | undefined): Promise<void> {
    if (!pattern) return;
    if (pattern.length > 200) throw badRequest('INVALID_REGEX', 'subjectRegex must be at most 200 characters');
    try {
      await this.db.query("SELECT '' ~* $1", [pattern]);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw badRequest('INVALID_REGEX', 'subjectRegex is not a valid regular expression');
    }
  }
}

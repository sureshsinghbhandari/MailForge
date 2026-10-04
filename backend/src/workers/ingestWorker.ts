import type { Logger } from '../logger.js';
import type { IngestService } from '../services/ingestService.js';
import type { CapturedMessageSummary, MailSource } from '../services/mailpitClient.js';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

/**
 * Pulls captured messages from the SMTP capture server, hands them to the ingest pipeline and then
 * deletes them from the capture server, so message data lives in one place only (our database).
 */
export class IngestWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private readonly failures = new Map<string, number>();
  public lastSuccessAt: Date | null = null;
  public lastError: string | null = null;

  constructor(
    private readonly source: MailSource,
    private readonly ingest: IngestService,
    private readonly log: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.pollOnce();
    } finally {
      this.schedule(this.intervalMs);
    }
  }

  /** One polling pass; returns the number of captured messages processed. Never throws. */
  async pollOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      const batch = await this.source.list(BATCH_SIZE);
      for (const summary of batch) {
        if (await this.processOne(summary)) processed += 1;
      }
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: this.lastError }, 'mail source poll failed');
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async processOne(summary: CapturedMessageSummary): Promise<boolean> {
    try {
      const raw = await this.source.getRaw(summary.id);
      const outcome = await this.ingest.ingest({
        raw,
        sourceId: summary.id,
        envelopeRecipients: summary.recipients,
      });
      if (outcome.skipped) {
        this.log.info({ sourceId: summary.id, reason: outcome.skipped }, 'captured message discarded');
      } else {
        this.log.info({ sourceId: summary.id, mailboxes: outcome.stored.length }, 'message ingested');
      }
      await this.source.delete([summary.id]);
      this.failures.delete(summary.id);
      return true;
    } catch (err) {
      const attempts = (this.failures.get(summary.id) ?? 0) + 1;
      this.failures.set(summary.id, attempts);
      this.log.error({ sourceId: summary.id, attempts, err: err instanceof Error ? err.message : String(err) }, 'ingest failed');
      if (attempts >= MAX_ATTEMPTS) {
        // Poison message: drop it so it cannot block the queue forever.
        this.failures.delete(summary.id);
        await this.source.delete([summary.id]).catch(() => undefined);
        this.log.error({ sourceId: summary.id }, 'message dropped after repeated ingest failures');
      }
      return false;
    }
  }
}

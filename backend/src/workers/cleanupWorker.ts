import type { Logger } from '../logger.js';
import type { CleanupService } from '../services/cleanupService.js';

export class CleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cleanup: CleanupService,
    private readonly log: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.cleanup
        .run()
        .catch((err: unknown) => this.log.error({ err: err instanceof Error ? err.message : String(err) }, 'cleanup failed'))
        .finally(() => this.schedule());
    }, this.intervalMs);
  }
}

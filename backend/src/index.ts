import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createDb } from './db/index.js';
import { defaultMigrationsDir, runMigrations } from './db/migrate.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { CleanupWorker } from './workers/cleanupWorker.js';
import { IngestWorker } from './workers/ingestWorker.js';

function loadDotenv(): void {
  // Development convenience; real environment variables always win. Docker passes env directly.
  for (const file of ['.env', '../.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* no such file */
    }
  }
}

async function waitForDatabase(db: { query: (sql: string) => Promise<unknown> }, log: ReturnType<typeof createLogger>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ attempt }, 'waiting for database');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  if (!config.API_AUTH_ENABLED) log.warn('API_AUTH_ENABLED=false: the API is OPEN. Never do this on a shared network.');

  const db = await createDb(config.DATABASE_URL);
  await waitForDatabase(db, log);
  await runMigrations(db, config.MIGRATIONS_DIR ?? defaultMigrationsDir(), log);
  await mkdir(config.ATTACHMENT_DIR, { recursive: true, mode: 0o750 });

  const ctx = createContext({ config, log, db });
  await ctx.auth.bootstrapAdmin();

  const app = createApp(ctx);
  const server: Server = app.listen(config.APP_PORT, () => {
    log.info({ port: config.APP_PORT, env: config.NODE_ENV, domains: config.MAIL_DOMAIN }, `${config.APP_NAME} backend listening`);
  });

  const ingestWorker = new IngestWorker(ctx.source, ctx.ingest, log, config.INGEST_POLL_INTERVAL_MS);
  const cleanupWorker = new CleanupWorker(ctx.cleanup, log, config.CLEANUP_INTERVAL_SECONDS * 1000);
  ingestWorker.start();
  cleanupWorker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    await ingestWorker.stop();
    await cleanupWorker.stop();
    server.close();
    server.closeAllConnections();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Startup failures (bad config, no database) must be loud and fatal.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

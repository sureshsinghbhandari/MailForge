import type { Config } from './config.js';
import type { Db } from './db/types.js';
import type { Logger } from './logger.js';
import { ApiKeyService } from './services/apiKeyService.js';
import { AttachmentStorage } from './services/attachmentStorage.js';
import { AuthService } from './services/authService.js';
import { CleanupService } from './services/cleanupService.js';
import { DashboardService } from './services/dashboardService.js';
import { EventBus } from './services/eventBus.js';
import { IngestService } from './services/ingestService.js';
import { MailboxService } from './services/mailboxService.js';
import { MailpitClient, type MailSource } from './services/mailpitClient.js';
import { MessageService } from './services/messageService.js';
import { WaitService } from './services/waitService.js';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  events: EventBus;
  storage: AttachmentStorage;
  source: MailSource;
  auth: AuthService;
  apiKeys: ApiKeyService;
  mailboxes: MailboxService;
  messages: MessageService;
  ingest: IngestService;
  wait: WaitService;
  cleanup: CleanupService;
  dashboard: DashboardService;
}

export function createContext(opts: { config: Config; log: Logger; db: Db; source?: MailSource }): AppContext {
  const { config, log, db } = opts;
  const events = new EventBus();
  const storage = new AttachmentStorage(config.ATTACHMENT_DIR);
  const source = opts.source ?? new MailpitClient(config.MAILPIT_API_URL);
  const auth = new AuthService(db, config, log);
  const apiKeys = new ApiKeyService(db);
  const mailboxes = new MailboxService(db, config, storage, events);
  const messages = new MessageService(db, storage, events);
  const ingest = new IngestService(db, config, mailboxes, storage, events, log);
  const wait = new WaitService(db, config, events, messages);
  const cleanup = new CleanupService(db, config, storage, auth, events, log);
  const dashboard = new DashboardService(db, source, config);
  return { config, log, db, events, storage, source, auth, apiKeys, mailboxes, messages, ingest, wait, cleanup, dashboard };
}

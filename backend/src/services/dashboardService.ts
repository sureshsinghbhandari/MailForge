import type { Config } from '../config.js';
import type { Db } from '../db/types.js';
import { toSummary, type MessageSummary } from './messageService.js';
import type { MailSource } from './mailpitClient.js';

export const EXPIRING_SOON_MINUTES = 15;

export interface DashboardData {
  activeMailboxes: number;
  totalMessages: number;
  messagesToday: number;
  unreadMessages: number;
  expiringSoon: number;
  recentMessages: MessageSummary[];
  smtp: ServiceStatus;
  database: ServiceStatus;
  app: ServiceStatus;
}

export type ServiceStatus = 'healthy' | 'unhealthy';

export interface HealthReport {
  status: ServiceStatus;
  database: ServiceStatus;
  smtp: ServiceStatus;
}

export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly source: MailSource,
    private readonly config: Config,
  ) {}

  async health(): Promise<HealthReport> {
    const [database, smtp] = await Promise.all([this.databaseStatus(), this.smtpStatus()]);
    return { status: database === 'healthy' && smtp === 'healthy' ? 'healthy' : 'unhealthy', database, smtp };
  }

  async databaseStatus(): Promise<ServiceStatus> {
    try {
      await this.db.query('SELECT 1');
      return 'healthy';
    } catch {
      return 'unhealthy';
    }
  }

  async smtpStatus(): Promise<ServiceStatus> {
    return (await this.source.isHealthy()) ? 'healthy' : 'unhealthy';
  }

  async dashboard(): Promise<DashboardData> {
    const counts = await this.db.query<{
      active_mailboxes: number;
      total_messages: number;
      messages_today: number;
      unread: number;
      expiring: number;
    }>(
      `SELECT
         (SELECT count(*) FROM mailboxes WHERE expires_at > now())::int AS active_mailboxes,
         (SELECT count(*) FROM messages)::int AS total_messages,
         (SELECT count(*) FROM messages WHERE received_at >= date_trunc('day', now()))::int AS messages_today,
         (SELECT count(*) FROM messages WHERE NOT is_read)::int AS unread,
         (SELECT count(*) FROM mailboxes
           WHERE expires_at > now() AND expires_at <= now() + make_interval(mins => $1))::int AS expiring`,
      [EXPIRING_SOON_MINUTES],
    );
    const recent = await this.db.query<Parameters<typeof toSummary>[0]>(
      `SELECT m.id, m.mailbox_id, mb.address AS mailbox_address, m.message_id, m.from_address, m.from_name,
              m.to_address, m.subject, m.preview, m.received_at, m.is_read, m.size, m.attachment_count,
              m.link_count, m.code_count
         FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
        ORDER BY m.received_at DESC LIMIT 10`,
    );
    const c = counts.rows[0]!;
    const [database, smtp] = await Promise.all([this.databaseStatus(), this.smtpStatus()]);
    return {
      activeMailboxes: c.active_mailboxes,
      totalMessages: c.total_messages,
      messagesToday: c.messages_today,
      unreadMessages: c.unread,
      expiringSoon: c.expiring,
      recentMessages: recent.rows.map(toSummary),
      smtp,
      database,
      app: 'healthy',
    };
  }

  /** Non-secret runtime configuration, shown on the Settings / System Status pages. */
  publicSettings() {
    const c = this.config;
    return {
      appName: c.APP_NAME,
      environment: c.NODE_ENV,
      mailDomains: c.MAIL_DOMAIN,
      smtpHost: c.SMTP_HOST,
      smtpPort: c.SMTP_PORT,
      defaultMailboxTtlMinutes: c.DEFAULT_MAILBOX_TTL_MINUTES,
      maxMailboxTtlMinutes: c.MAX_MAILBOX_TTL_MINUTES,
      ttlPresetsMinutes: [5, 15, 30, 60, 360, 1440].filter((m) => m <= c.MAX_MAILBOX_TTL_MINUTES),
      maxEmailSizeMb: c.MAX_EMAIL_SIZE_MB,
      maxAttachmentSizeMb: c.MAX_ATTACHMENT_SIZE_MB,
      cleanupIntervalSeconds: c.CLEANUP_INTERVAL_SECONDS,
      messageRetentionHours: c.MESSAGE_RETENTION_HOURS,
      attachmentRetentionHours: c.ATTACHMENT_RETENTION_HOURS,
      mailboxRetentionHours: c.MAILBOX_RETENTION_HOURS,
      apiAuthEnabled: c.API_AUTH_ENABLED,
      rateLimits: {
        login: c.LOGIN_RATE_LIMIT,
        api: c.API_RATE_LIMIT,
        mailboxCreation: c.MAILBOX_CREATION_RATE_LIMIT,
        search: c.SEARCH_RATE_LIMIT,
        download: c.DOWNLOAD_RATE_LIMIT,
      },
    };
  }
}

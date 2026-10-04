/** Types mirroring the backend API contract (backend/src/services/*). */

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface AuthUser {
  id: string | null;
  email: string | null;
}

export interface MeResponse {
  user: AuthUser;
  authType: string;
  csrfToken: string | null;
}

export interface LoginResponse {
  user: AuthUser;
  csrfToken: string;
}

export type MailboxStatus = 'active' | 'expired';

export interface Mailbox {
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
  linkType: string;
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
  /** Server-sanitised HTML fragment; only used to know whether an HTML part exists. */
  html: string | null;
  headers: Array<{ name: string; value: string }>;
  attachments: AttachmentView[];
  codes: CodeView[];
  links: LinkView[];
  verificationCode: string | null;
  verificationUrl: string | null;
}

export type ServiceStatus = 'healthy' | 'unhealthy';

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

export interface PublicSettings {
  appName: string;
  environment: string;
  mailDomains: string[];
  smtpHost: string;
  smtpPort: number;
  defaultMailboxTtlMinutes: number;
  maxMailboxTtlMinutes: number;
  ttlPresetsMinutes: number[];
  maxEmailSizeMb: number;
  maxAttachmentSizeMb: number;
  cleanupIntervalSeconds: number;
  messageRetentionHours: number;
  attachmentRetentionHours: number;
  mailboxRetentionHours: number;
  apiAuthEnabled: boolean;
  rateLimits: {
    login: string;
    api: string;
    mailboxCreation: string;
    search: string;
    download: string;
  };
}

export interface CleanupResult {
  mailboxesDeleted: number;
  messagesDeleted: number;
  attachmentFilesDeleted: number;
  sessionsDeleted: number;
  ranAt: string;
  durationMs: number;
}

export interface SystemStatus {
  status: ServiceStatus;
  database: ServiceStatus;
  smtp: ServiceStatus;
  version: string;
  uptimeSeconds: number;
  lastCleanup: CleanupResult | null;
  settings: PublicSettings;
}

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type MessageFilter = 'all' | 'unread' | 'read' | 'attachments' | 'codes' | 'links' | 'today' | 'hour';

export type AppEvent =
  | { type: 'EMAIL_RECEIVED'; mailboxId: string; messageId: string; from: string; subject: string; receivedAt: string }
  | { type: 'MAILBOX_CREATED'; mailboxId: string; address: string }
  | { type: 'MAILBOX_DELETED'; mailboxId: string }
  | { type: 'MESSAGE_DELETED'; mailboxId: string; messageId: string }
  | { type: 'MESSAGES_CLEARED'; mailboxId: string }
  /** Client-side only: the stream re-opened after an error, so views should refetch. */
  | { type: 'RECONNECTED' };

export const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@mailtest.local';
export const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'e2e-admin-password-1';
export const SMTP_PORT = Number(process.env['E2E_SMTP_PORT'] ?? 11025);
export const SMTP_HOST = process.env['E2E_SMTP_HOST'] ?? '127.0.0.1';
export const MAIL_DOMAIN = process.env['E2E_MAIL_DOMAIN'] ?? 'mailtest.local';

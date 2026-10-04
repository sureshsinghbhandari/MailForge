import { defineConfig } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, MAIL_DOMAIN, SMTP_PORT } from './support/env.js';

/**
 * End-to-end stack (no Docker required):
 *   fake SMTP capture server (Mailpit-compatible)  ->  real backend (embedded PostgreSQL)  ->  built React UI
 * served through an nginx-equivalent that applies the production CSP from frontend/nginx.conf.
 * With Docker, point the tests at the real stack instead:  E2E_BASE_URL=http://localhost:8080 E2E_SMTP_PORT=1025 \
 *   E2E_EXTERNAL_STACK=1 npm run test:e2e   (see docs/ARCHITECTURE.md)
 */
const external = process.env['E2E_EXTERNAL_STACK'] === '1';
const frontendPort = 4173;
const backendPort = 3101;


const backendEnv = {
  NODE_ENV: 'development',
  APP_PORT: String(backendPort),
  LOG_LEVEL: 'warn',
  DATABASE_URL: 'pglite://memory',
  MAIL_DOMAIN,
  MAILPIT_API_URL: 'http://127.0.0.1:18025',
  INGEST_POLL_INTERVAL_MS: '200',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ATTACHMENT_DIR: './test-results/attachments',
  CLEANUP_INTERVAL_SECONDS: '1',
  MAILBOX_RETENTION_HOURS: '0',
  TRUST_PROXY: '1',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${frontendPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Use the installed Edge/Chrome so no browser download is needed; set PW_CHANNEL= (empty) to use Playwright's own Chromium.
    channel: process.env['PW_CHANNEL'] ?? (process.platform === 'win32' ? 'msedge' : undefined),
  },
  webServer: external
    ? undefined
    : [
        {
          command: 'npx tsx support/fake-mailpit.ts',
          url: 'http://127.0.0.1:18025/livez',
          reuseExistingServer: false,
          env: { FAKE_SMTP_PORT: String(SMTP_PORT), FAKE_MAILPIT_HTTP_PORT: '18025' },
        },
        {
          command: 'npx tsx ../backend/src/index.ts',
          url: `http://127.0.0.1:${backendPort}/api/health`,
          reuseExistingServer: false,
          env: backendEnv,
          timeout: 90_000,
        },
        ...(process.env['E2E_SKIP_UI'] === '1'
          ? []
          : [
              {
                command: 'npm --prefix ../frontend run build && npx tsx support/prod-like-server.ts',
                url: `http://127.0.0.1:${frontendPort}/`,
                reuseExistingServer: false,
                env: { PORT: String(frontendPort), BACKEND_URL: `http://127.0.0.1:${backendPort}` },
                timeout: 180_000,
              },
            ]),
      ],
});

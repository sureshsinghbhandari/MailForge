# MailForge — private disposable-email testing platform

Create throw-away mailboxes such as `signup-a8f72c@mailtest.local`, point your application's SMTP at MailForge, and read what it sent — in a web UI, over a REST API, or from your Playwright/Cypress tests. Everything runs on infrastructure you control: **no Mailinator, Temp-Mail, Guerrilla Mail or any other third-party service**, and it is built so it can never act as an open relay.

* **Mailboxes** with random or custom prefixes, TTLs from 1 minute to 24 h (configurable), automatic expiry and cleanup
* **Inbox & viewer**: HTML (sanitised, sandboxed), plain text, all headers, raw `.eml`, attachments, search, filters, bulk delete
* **Extraction**: verification codes (keyword-anchored, so invoice numbers, prices, dates and phone numbers are ignored) and links (verification / reset / magic links are flagged). Links are never followed
* **Automation**: `POST /api/test/mailbox` + `wait-for-email` returning the code and verification URL
* **Real time**: Server-Sent Events update the UI the moment mail arrives
* **Security**: admin login (Argon2id), hashed API keys, CSRF protection, rate limits, strict CSP, SMTP recipient allow-list — see [docs/SECURITY.md](docs/SECURITY.md)

```
 application under test ──SMTP──► Mailpit ──► backend (parse · extract · store) ──► PostgreSQL
                                                  │  REST + SSE                          
                                       React UI ◄─┘◄── your tests (API key)
```
More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Verification status — read this first

This repository was built and verified on a Windows machine **without Docker or PostgreSQL**. What that means:

| Verified (automated, passing) | Not verified here |
| --- | --- |
| 183 backend tests (unit, API, security, ingest, cleanup, SSE) on a real PostgreSQL engine (PGlite), 33 frontend tests, 14 Playwright e2e tests | `docker compose config/build/up`, the Dockerfiles, nginx and Caddy configs (written carefully, but never executed) |
| Full SMTP → capture → backend → database → API/SSE path over real sockets using a Mailpit-compatible stand-in | Behaviour of the **real Mailpit image** (`axllent/mailpit:v1.27`): its HTTP API shapes were taken from its documentation, and the `MP_SMTP_ALLOWED_RECIPIENTS` relay protection is asserted for the stand-in and the compose file, not observed on Mailpit itself |
| UI end-to-end in a real browser (Edge) against the production CSP | Postgres 17 container, healthchecks, volume permissions, `read_only` containers |

First thing to do on a machine with Docker: `docker compose up -d --build`, then `E2E_EXTERNAL_STACK=1 … npm run test:e2e` (see [ARCHITECTURE.md](docs/ARCHITECTURE.md#testing-strategy)) and try relaying to an outside address (`swaks --to victim@gmail.com --server localhost:1025` must fail with `550`).

## Quick start (Docker)

Prerequisites: Docker with Compose ≥ 2.24.

```bash
cp .env.example .env        # optional for development; defaults work
docker compose up -d --build
```

| | |
| --- | --- |
| Web UI | http://localhost:8080 — `admin@mailtest.local` / `dev-admin-password-123` (change in `.env`) |
| Backend API | http://localhost:3000/api (dev stack only) |
| Mailpit UI | http://localhost:8025 |
| SMTP | `localhost:1025` |

Load sample data (dev only): `docker compose exec backend node backend/dist/scripts/seed.js`.

### Create a mailbox

* **UI**: *Mailboxes → New mailbox* (pick a prefix and an expiry).
* **API**:
  ```bash
  curl -s -X POST http://localhost:8080/api/test/mailbox \
    -H "Authorization: Bearer $MAILFORGE_KEY" -H 'content-type: application/json' \
    -d '{"prefix":"signup","ttlMinutes":15}'
  # {"success":true,"data":{"email":"signup-a8f72c@mailtest.local","mailboxId":"…","expiresAt":"…"}}
  ```
  Create the key under *API Keys* (shown once).

### Send a test email

```js
const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 1025, secure: false });
await transporter.sendMail({
  from: 'noreply@example.com',
  to: 'signup-a8f72c@mailtest.local',
  subject: 'Verify your account',
  text: 'Your verification code is 482913',
});
```
From the host `SMTP_HOST=localhost`; from another container on the compose network `mailpit`.

### Use it from Playwright

```ts
const mail = await playwright.request.newContext({
  baseURL: 'http://localhost:8080',
  extraHTTPHeaders: { Authorization: `Bearer ${process.env.MAILFORGE_KEY}` },
});
const { email, mailboxId } = (await (await mail.post('/api/test/mailbox', { data: {} })).json()).data;

// … drive your app's sign-up form with `email` …

const res = await mail.post(`/api/test/mailbox/${mailboxId}/wait-for-email`, {
  data: { subjectRegex: 'Verify.*Account', timeoutMs: 30_000 },
});
const { received, verificationCode, verificationUrl } = (await res.json()).data;
await page.goto(verificationUrl);
```
Full API reference: [docs/API.md](docs/API.md) · [docs/openapi.yaml](docs/openapi.yaml).

## Development without Docker

**Windows shortcut:** double-click `start-dev.bat`. It installs packages on first run, writes a dev `.env` (embedded PostgreSQL, backend on port 3100), and opens three windows: SMTP stand-in (`127.0.0.1:11025`), backend, and frontend at http://localhost:5173. Log in with `admin@mailtest.local` / `dev-admin-password-123`. Close the windows to stop.

Manual steps:

Requires Node.js ≥ 22.

```bash
npm install
cp .env.example .env     # set DATABASE_URL=pglite://./data/pg  → embedded PostgreSQL, nothing to install
npm run seed
npm run dev:backend      # :3000
npm run dev:frontend     # :5173
```
Real SMTP capture needs Mailpit (or `npm run fake-mailpit -w tests`, a stand-in on SMTP 11025 / HTTP 18025 → `MAILPIT_API_URL=http://127.0.0.1:18025`).

### Commands

| Command | Does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint (type-aware promise rules on the backend) |
| `npm test` | backend + frontend unit/API/security tests |
| `npm run build` | compile backend, bundle frontend |
| `npm run test:e2e` | Playwright: SMTP→API integration + browser UI test (Edge/Chrome via `PW_CHANNEL`, or `PW_CHANNEL= npx playwright install chromium`) |

## Configuration

Copy `.env.example`; every variable is documented there and validated at startup (the backend refuses to start on bad values). The important ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAIL_DOMAIN` | `mailtest.local` | Domain(s) for mailboxes (comma separated). `.local` is **not publicly routable** — fine locally, use a real domain + MX for inbound internet mail |
| `SMTP_ALLOWED_RECIPIENTS_REGEX` | matches `MAIL_DOMAIN` | Mailpit rejects every other recipient — keep in sync |
| `DEFAULT_MAILBOX_TTL_MINUTES` / `MAX_MAILBOX_TTL_MINUTES` | 60 / 1440 | Mailbox lifetime |
| `MESSAGE_/ATTACHMENT_/MAILBOX_RETENTION_HOURS` | 24 | Permanent removal of old data; `CLEANUP_INTERVAL_SECONDS=60` |
| `MAX_EMAIL_SIZE_MB` / `MAX_ATTACHMENT_SIZE_MB` | 20 / 10 | Size limits |
| `API_AUTH_ENABLED` | `true` | `false` only for local experiments; refused in production |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | dev defaults | Creates the first admin; production requires a strong password |
| `*_RATE_LIMIT` | e.g. `10/15m`, `1000/hour` | login, API, mailbox creation, search, download |
| `VERIFICATION_CODE_KEYWORDS` / `_PATTERNS` | empty | Extend code detection |

## Production

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
Requires real secrets, serves HTTPS on 80/443 only (Caddy), keeps the database, API and Mailpit UI private. Details, DNS records (A/AAAA, MX, SPF, DKIM, DMARC), firewall rules, backups and upgrades: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/SECURITY.md](docs/SECURITY.md).

**SMTP security in one paragraph:** the SMTP server accepts mail only for your configured domain(s) and rejects everything else at `RCPT TO` (so it cannot be abused as a relay); it has no relay configuration; the backend has no code that sends email; SMTP is published on loopback only unless you opt in and firewall it.

**Backup:** `scripts/backup-db.sh` / `scripts/restore-db.sh`. **Retention:** temporary data is deleted automatically (default 24 h).

## Repository layout

```
backend/    Express + TypeScript API, ingest pipeline, workers, tests
frontend/   React + Vite + Tailwind UI, nginx.conf
database/   SQL migrations
tests/      Playwright e2e/integration tests and support servers
scripts/    backup-db.sh, restore-db.sh
deploy/     Caddyfile for production TLS
docs/       API.md, openapi.yaml, ARCHITECTURE.md, SECURITY.md, DEPLOYMENT.md
```

## Troubleshooting

See [docs/DEPLOYMENT.md#troubleshooting](docs/DEPLOYMENT.md#troubleshooting). Quick hits: SMTP `550` → recipient outside `MAIL_DOMAIN`; mail not appearing → the mailbox must exist and be unexpired before the mail is sent; 401 in scripts → use `Authorization: Bearer mf_…`; 403 `CSRF_TOKEN_INVALID` → browser sessions need `X-CSRF-Token` (API keys don't).

## Limitations

Single backend instance and single tenant (all admins/keys see all mailboxes); no per-IP SMTP rate limiting inside Mailpit (use the firewall); `<style>` blocks in HTML mail are stripped; no password-change UI (use the reset script); see [docs/SECURITY.md](docs/SECURITY.md#known-limitations).

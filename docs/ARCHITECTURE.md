# Architecture

MailForge is a private, self-hosted replacement for public disposable-email services. Your applications send real SMTP mail to addresses on a domain you control; MailForge captures it, parses it, extracts verification codes and links, and exposes everything through a web UI, a REST API and a real-time event stream. No third-party service is involved at any point.

```
   Application under test
            │  SMTP (port 1025, Docker network / loopback)
            ▼
   ┌─────────────────────┐       Rejects every RCPT TO outside MAIL_DOMAIN (MP_SMTP_ALLOWED_RECIPIENTS).
   │ Mailpit             │       Has no relay configuration, so it cannot forward anything.
   │ private SMTP capture│
   └─────────┬───────────┘
             │  HTTP API (internal only): list → fetch raw → delete
             ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ backend (Node.js · Express · TypeScript)                      │
   │                                                               │
   │  IngestWorker ──► IngestService ──► parse MIME (mailparser)   │
   │   (polls ~1 s)       │              resolve recipient → mailbox
   │                      │              extract codes + links     │
   │                      │              store message/attachments │
   │                      ▼                                        │
   │                  EventBus ──► SSE /api/events                 │
   │                      └──────► wait-for-email long-polls       │
   │                                                               │
   │  REST API · auth (sessions + API keys) · rate limits · CSRF   │
   │  CleanupWorker (expiry + retention)                           │
   └──────────────┬──────────────────────────────┬─────────────────┘
                  ▼                              ▼
          PostgreSQL (metadata,         attachment volume
          bodies, raw .eml)             (/data/attachments, UUID names)
                  ▲
                  │ REST + SSE (same origin, via nginx)
   ┌──────────────┴──────────────┐
   │ frontend (React · Vite ·    │   HTML mail is rendered only inside a sandboxed,
   │ Tailwind, served by nginx)  │   script-less iframe with its own strict CSP.
   └─────────────────────────────┘
```

## Why a pull model

The backend polls Mailpit's HTTP API (`IngestWorker`, default every second) rather than being pushed to. A push webhook needs an unauthenticated inbound endpoint; polling keeps the backend's only inbound surface the authenticated API. After a message is stored the backend deletes it from Mailpit, so message data lives in one place (PostgreSQL) and Mailpit is just a disposable SMTP front door. If ingestion of a message fails three times it is dropped so a poison message cannot block the queue.

The SMTP front door is behind one small interface (`MailSource` in `backend/src/services/mailpitClient.ts`: `list`, `getRaw`, `delete`, `isHealthy`). To use Postfix, Haraka or an IMAP/Maildir bridge later, implement that interface (or point a bridge at the Mailpit-compatible HTTP shape) – nothing else changes. The ingest pipeline itself (`IngestService.ingest({ raw, sourceId, envelopeRecipients })`) is also callable directly, which is how the tests and the seed script deliver mail.

## Components

| Path | Responsibility |
| --- | --- |
| `backend/src/config.ts` | Zod-validated environment; fails fast at startup; production hardening rules |
| `backend/src/db/` | `Db` abstraction (`pg` for PostgreSQL, PGlite for tests and Docker-free dev), SQL migration runner |
| `database/migrations/` | Versioned SQL migrations (`schema_migrations` table) |
| `backend/src/services/ingestService.ts` | Pipeline: size check → parse → validate recipients → store → extract → publish |
| `backend/src/services/parseEmail.ts` | MIME parsing, header list, attachment extraction, filename sanitising, NUL scrubbing |
| `backend/src/services/codeExtractor.ts` | Keyword-anchored verification-code detection (configurable) |
| `backend/src/services/linkExtractor.ts` | URL extraction (text + HTML hrefs) and classification |
| `backend/src/services/sanitizeHtml.ts`, `emailDocument.ts` | Allow-list HTML sanitiser; sandbox document + CSP builder |
| `backend/src/services/mailboxService.ts`, `messageService.ts` | Mailbox lifecycle, message queries/search/filters |
| `backend/src/services/waitService.ts` | `wait-for-email` (event-driven with a 2 s fallback poll) |
| `backend/src/services/authService.ts`, `apiKeyService.ts` | Argon2id passwords, hashed sessions, hashed API keys |
| `backend/src/services/cleanupService.ts` + `workers/` | Expiry and retention |
| `backend/src/http/` | Express app, middleware (auth, CSRF, rate limiting, errors), routes |
| `frontend/` | React SPA + nginx config |
| `tests/` | Playwright end-to-end/integration tests and their support servers |

## Data model

`users`, `sessions`, `api_keys`, `mailboxes`, `messages`, `attachments`, `message_links`, `verification_codes`, `audit_logs` (+ `schema_migrations`). See `database/migrations/001_init.sql`. Highlights:

* Foreign keys cascade from `mailboxes` → `messages` → `attachments` / `message_links` / `verification_codes`, so deleting a mailbox removes everything beneath it; attachment *files* are removed explicitly by the service that issued the delete.
* `mailboxes.address` is unique and constrained to lower case; indexes cover `messages(mailbox_id)`, `messages(received_at)`, `messages(subject)`, `mailboxes(expires_at)`.
* `messages(mailbox_id, source_id)` is unique (where `source_id` is set) so re-processing the same captured message is idempotent.
* Mailbox *status* (`active`/`expired`) is derived from `expires_at`, never stored, so it cannot drift.
* Only hashes are stored for passwords (Argon2id), session tokens and API keys (SHA-256).

## Lifecycle and retention

1. A mailbox is created with a TTL (default 60 min, max `MAX_MAILBOX_TTL_MINUTES`). It receives mail until `expires_at`.
2. After expiry it no longer accepts mail. It is **permanently deleted `MAILBOX_RETENTION_HOURS` later** (0 = immediately; default 24), together with its messages and attachment files. "Delete expired mailboxes" in the UI/API does this right away.
3. Independently, messages older than `MESSAGE_RETENTION_HOURS` are deleted, and attachment files older than `ATTACHMENT_RETENTION_HOURS` are removed (the message stays, the attachment is marked "not stored").
4. The cleanup worker runs every `CLEANUP_INTERVAL_SECONDS`, logs what it removed and writes an audit entry.

## Real-time and automated testing

`IngestService` publishes `EMAIL_RECEIVED` on the in-process `EventBus` after the database transaction commits. Two consumers use it: the SSE endpoint (`/api/events`, which feeds the UI) and `WaitService` (which re-checks the database for a match whenever mail arrives for the mailbox it is waiting on). The bus is in-process, so run **one backend instance** (the default). Scaling out would require swapping it for PostgreSQL `LISTEN/NOTIFY` or Redis.

## Testing strategy

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `backend/test/unit` | code/link extraction, sanitiser, addresses, TTL, config, compose/deployment guarantees |
| API + security | `backend/test/api` | every endpoint against a real PostgreSQL engine (PGlite): auth, CSRF, validation, search, test API, API keys, rate limits, SQL injection, XSS, path traversal, relay prevention, cleanup, SSE |
| Integration | `tests/e2e/api-flow.spec.ts` | real SMTP socket → capture server → backend → database → API/SSE; relay refusal; automatic expiry |
| UI end-to-end | `tests/e2e/ui-flow.spec.ts` | login → create mailbox → send SMTP mail → live inbox update → viewer → delete, under the production CSP |

`npm run test:e2e` starts a Mailpit-compatible stand-in (`tests/support/fake-mailpit.ts`), the real backend on an embedded PostgreSQL, and the built UI behind an nginx-equivalent server. This runs without Docker. To run the same specs against the real Docker stack, set `E2E_EXTERNAL_STACK=1`, `E2E_BASE_URL=http://localhost:8080`, `E2E_API_URL=http://localhost:3000`, `E2E_SMTP_PORT=1025`, and the admin credentials from your `.env`. (The 70-second expiry test and the stand-in-specific assertions assume the e2e stack's 1-second cleanup interval.)

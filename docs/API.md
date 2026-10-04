# MailForge REST API

Base URL: `http://localhost:8080/api` (through the frontend proxy) or `http://localhost:3000/api` (backend directly, development stack only). A machine-readable description is in [`openapi.yaml`](openapi.yaml).

## Conventions

**Authentication.** Every endpoint except `GET /api/health` and `POST /api/auth/login` needs credentials:

| Caller | Credential | Notes |
| --- | --- | --- |
| Test suites / scripts | `Authorization: Bearer mf_…` (an API key) | No cookie, no CSRF header. Keys cannot manage keys. |
| The web UI | `mf_session` cookie (HttpOnly, SameSite=Strict, Secure in production) | State-changing requests also need `X-CSRF-Token: <csrfToken>` from `/api/auth/login` or `/api/auth/me`. |

A request with an invalid `Authorization` header is rejected with `401` even if a valid cookie is also present. API keys are never accepted in query strings.

**Envelope.**

```json
{ "success": true, "data": { } }
{ "success": true, "data": [ ], "meta": { "page": 1, "pageSize": 25, "total": 3 } }
{ "success": false, "error": { "code": "MAILBOX_NOT_FOUND", "message": "Mailbox not found" } }
```

`GET /api/health` is the one exception: it returns the bare object `{ "status", "database", "smtp" }` so Docker/load-balancer health checks stay trivial. Validation failures add `error.details` (`[{ "path", "message" }]`). Stack traces are never returned.

**Errors.** `400` validation/malformed, `401` unauthenticated, `403` CSRF/origin/forbidden, `404` not found, `409` limit reached, `410` attachment no longer stored, `413` body too large, `429` rate limited (with standard `RateLimit` headers and `Retry-After`), `500` internal (details only in server logs).

**Pagination.** `page` (default 1) and `pageSize` (default 25, max 100). Results are newest first.

**Identifiers** are UUIDs. A malformed id is reported as `404 …_NOT_FOUND`.

**Rate limits** (per API key / session, configurable): `API_RATE_LIMIT` (all endpoints), `MAILBOX_CREATION_RATE_LIMIT`, `SEARCH_RATE_LIMIT` (message lists), `DOWNLOAD_RATE_LIMIT` (raw/attachments), `LOGIN_RATE_LIMIT` (failed logins per IP).

---

## Health

### `GET /api/health` — public

```json
{ "status": "healthy", "database": "healthy", "smtp": "healthy" }
```
Returns `503` with `"unhealthy"` values if the database or the SMTP capture server is unreachable.

## Auth (web UI)

### `POST /api/auth/login` — public
Request `{ "email": "admin@mailtest.local", "password": "…" }` → `200`

```json
{ "success": true, "data": { "user": { "id": "…", "email": "admin@mailtest.local" }, "csrfToken": "…" } }
```
Sets the `mf_session` cookie. `401 INVALID_CREDENTIALS` is returned identically for unknown user and wrong password. Only failed attempts count towards `LOGIN_RATE_LIMIT`.

### `POST /api/auth/logout`
Revokes the session and clears the cookie → `{ "loggedOut": true }`.

### `GET /api/auth/me`
→ `{ "user": { "id", "email" }, "authType": "session" | "apiKey", "csrfToken": "…" | null }`

## Mailboxes

### `POST /api/mailboxes`
Request (all optional): `{ "prefix": "signup", "ttlMinutes": 60 }`. `prefix` is 1–32 chars of `a-z 0-9 . _ -` (starting/ending alphanumeric; default `test`). `ttlMinutes` is a positive integer ≤ `MAX_MAILBOX_TTL_MINUTES` (default `DEFAULT_MAILBOX_TTL_MINUTES`; the UI offers 5/15/30/60/360/1440).

→ `201`
```json
{ "success": true, "data": {
  "id": "5f0c…", "email": "signup-a8f72c@mailtest.local", "prefix": "signup", "domain": "mailtest.local",
  "status": "active", "expiresAt": "2026-10-04T16:30:00.000Z", "createdAt": "2026-10-04T15:30:00.000Z",
  "messageCount": 0, "unreadCount": 0 } }
```
Errors: `INVALID_PREFIX`, `INVALID_TTL`, `TTL_TOO_LONG`, `DOMAIN_NOT_ALLOWED`, `409 MAILBOX_LIMIT_REACHED`.

### `GET /api/mailboxes`
Query: `status=active|expired`, `search` (substring of the address), `page`, `pageSize`. → list of mailbox objects with `meta`.

### `GET /api/mailboxes/:id` → mailbox object. `404 MAILBOX_NOT_FOUND`.

### `DELETE /api/mailboxes/:id`
Permanently deletes the mailbox, its messages and attachment files → `{ "deleted": true }`.

### `DELETE /api/mailboxes/expired?confirm=true`
Bulk delete of every expired mailbox now (instead of waiting for retention) → `{ "deleted": 2 }`. Without `confirm=true`: `400 VALIDATION_ERROR`.

### `GET /api/mailboxes/:id/messages`
Same filters as `GET /api/messages` (below) scoped to the mailbox.

### `DELETE /api/mailboxes/:id/messages?confirm=true`
Deletes all messages in the mailbox → `{ "deleted": 4 }`.

## Messages

### `GET /api/messages`
Query parameters (all optional, combined with AND):

| Parameter | Meaning |
| --- | --- |
| `search` | substring in sender, recipient, subject, text body, verification codes or URLs |
| `from`, `to`, `subject` | substring of sender (address or name), recipient (header or mailbox), subject |
| `code` | exact verification code |
| `url` | substring of an extracted link |
| `mailboxId` | restrict to one mailbox |
| `dateFrom`, `dateTo` | ISO-8601 with offset, e.g. `2026-10-04T00:00:00Z` |
| `filter` | `all` (default), `unread`, `read`, `attachments`, `codes`, `links`, `today` (since 00:00 server time), `hour` (last 60 min) |
| `page`, `pageSize` | pagination |

`%` and `_` are matched literally. → list of message summaries:

```json
{ "id": "…", "mailboxId": "…", "mailboxEmail": "signup-a8f72c@mailtest.local", "messageId": "<abc@example.com>",
  "fromAddress": "noreply@example.com", "fromName": "Example App", "to": "signup-a8f72c@mailtest.local",
  "subject": "Verify your account", "preview": "Your verification code is 482913", "receivedAt": "…",
  "isRead": false, "size": 1423, "attachmentCount": 0, "linkCount": 1, "codeCount": 1 }
```

### `GET /api/messages/:id`
A summary plus: `cc`, `bcc`, `replyTo`, `text`, `html` (**sanitised fragment**, never the raw HTML), `headers` (`[{ "name", "value" }]` in original order, including every `Received`), `attachments`, `codes`, `links`, `verificationCode` (best code or `null`), `verificationUrl` (best verification link or `null`). Does **not** mark the message read.

### `PATCH /api/messages/:id` — `{ "isRead": true }` → `{ "isRead": true }`

### `DELETE /api/messages/:id` → `{ "deleted": true }`

### `GET /api/messages/:id/raw`
The original RFC 5322 message as `text/plain` (for viewing). `?download=true` returns `message/rfc822` with `Content-Disposition: attachment; filename="message.eml"`.

### `GET /api/messages/:id/html?images=true|false`
The sanitised HTML as a standalone document for a sandboxed iframe, served with a strict CSP header (`default-src 'none'; img-src data:` — remote images only when `images=true` — and `sandbox allow-popups allow-popups-to-escape-sandbox`). `404 NO_HTML_BODY` when the message has no HTML part.

### `GET /api/messages/:id/codes`
```json
{ "success": true, "data": [ { "code": "482913", "codeType": "numeric", "confidence": 0.95 } ] }
```

### `GET /api/messages/:id/links`
```json
{ "success": true, "data": [ { "url": "https://app.example.com/verify?token=abc", "linkType": "verify", "isVerification": true } ] }
```
`linkType` is one of `verify`, `confirm`, `activate`, `magic_link`, `reset_password`, `login`, `unsubscribe`, `other`. MailForge never follows links.

### `GET /api/messages/:id/attachments`
`[{ "id", "filename", "mimeType", "size", "stored" }]` (`stored: false` when the file exceeded `MAX_ATTACHMENT_SIZE_MB` or passed `ATTACHMENT_RETENTION_HOURS`).

### `GET /api/messages/:id/attachments/:attachmentId`
Downloads the bytes with `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a sandbox CSP. `410 ATTACHMENT_NOT_STORED` if not stored.

## Automated testing API

Designed for Playwright/Cypress/API test suites. Use an API key.

### `POST /api/test/mailbox`
Request `{ "prefix"?: "…", "ttlMinutes"?: 15 }` → `201`
```json
{ "success": true, "data": { "email": "test-8a73f2@mailtest.local", "mailboxId": "…", "expiresAt": "…" } }
```

### Wait for an email
All variants long-poll until a **matching message exists in the mailbox** (messages that already arrived count) or the timeout passes. The newest match wins.

* `GET  /api/test/mailbox/:id/wait-for-email?timeoutMs=30000&subject=Verify` (query string)
* `POST /api/test/mailbox/:id/wait-for-email` (JSON body)
* `POST /api/test/wait-for-email` (JSON body including `mailboxId`)

| Field | Match |
| --- | --- |
| `timeoutMs` | default 30 000, min 100, clamped to `MAX_WAIT_TIMEOUT_MS` (default 120 000) |
| `subject` | case-insensitive substring |
| `subjectRegex` | PostgreSQL POSIX regex, case-insensitive (≤ 200 chars); evaluated in the database, so it cannot stall the API. `400 INVALID_REGEX` if it does not compile |
| `from` | substring of the sender address or name |
| `to` | substring of the recipient |
| `messageId` | exact `Message-ID` header (include the angle brackets) |
| `receivedAfter` | ISO-8601; only messages received strictly after this instant |

Found → `200`
```json
{ "success": true, "data": {
  "received": true, "messageId": "…", "mailboxId": "…", "from": "noreply@example.com", "to": "test-8a73f2@mailtest.local",
  "subject": "Verify your account", "receivedAt": "…",
  "verificationCode": "482913", "verificationCodes": ["482913"],
  "verificationUrl": "https://example.com/verify?token=abc", "links": ["https://example.com/verify?token=abc"] } }
```
Timed out → `200 { "success": true, "data": { "received": false } }` (not an HTTP error, so test code decides how to fail). Unknown mailbox → `404`.

## API keys (web session required)

### `POST /api/api-keys` — `{ "name": "CI" }` → `201`
```json
{ "success": true, "data": { "id": "…", "name": "CI", "keyPrefix": "mf_AbCdEfG", "key": "mf_…43 chars…", "createdAt": "…", "lastUsedAt": null, "revokedAt": null } }
```
`key` is shown **once**; only its SHA-256 is stored.

### `GET /api/api-keys` → keys with `lastUsedAt`/`revokedAt` (never the key itself).
### `DELETE /api/api-keys/:id` → revokes immediately: `{ "revoked": true }`.

## Dashboard & system

### `GET /api/dashboard`
```json
{ "activeMailboxes": 12, "totalMessages": 48, "messagesToday": 48, "unreadMessages": 7, "expiringSoon": 3,
  "recentMessages": [ /* ≤10 summaries */ ], "smtp": "healthy", "database": "healthy", "app": "healthy" }
```
`expiringSoon` = active mailboxes expiring within 15 minutes.

### `GET /api/system/status`
Health, `version`, `uptimeSeconds`, `lastCleanup`, and non-secret `settings` (domains, TTL limits, size limits, retention, rate limits).

### `POST /api/system/cleanup` (web session) — run the cleanup worker now → counts of removed items.

### `GET /api/events` — Server-Sent Events
`Content-Type: text/event-stream`. Each event has `event: <TYPE>` and a JSON `data:` line that also contains `type`:

```
event: EMAIL_RECEIVED
data: {"type":"EMAIL_RECEIVED","mailboxId":"…","messageId":"…","from":"noreply@example.com","subject":"Verify your account","receivedAt":"…"}
```
Other types: `MAILBOX_CREATED`, `MAILBOX_DELETED`, `MESSAGE_DELETED`, `MESSAGES_CLEARED`. A `: ping` comment is sent every 20 s. Browsers use the session cookie; other clients can read the stream with `fetch` and a Bearer key.

---

## Examples

### curl
```bash
KEY=mf_…
MB=$(curl -s -X POST localhost:8080/api/test/mailbox -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"prefix":"signup"}')
echo "$MB"                    # {"success":true,"data":{"email":"signup-…@mailtest.local","mailboxId":"…","expiresAt":"…"}}
# … make your application send mail to that address …
curl -s "localhost:8080/api/test/mailbox/<mailboxId>/wait-for-email?timeoutMs=30000&subject=Verify" -H "Authorization: Bearer $KEY"
```

### Playwright test helper
```ts
import { test, expect } from '@playwright/test';

const api = { baseURL: process.env.MAILFORGE_URL!, headers: { Authorization: `Bearer ${process.env.MAILFORGE_KEY}` } };

test('sign-up flow', async ({ page, playwright }) => {
  const mail = await playwright.request.newContext(api);
  const { email, mailboxId } = (await (await mail.post('/api/test/mailbox', { data: { prefix: 'signup' } })).json()).data;

  await page.goto('https://staging.example.com/register');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign up' }).click();

  const res = await mail.post(`/api/test/mailbox/${mailboxId}/wait-for-email`, {
    data: { subjectRegex: 'Verify.*Account', timeoutMs: 30_000 },
  });
  const { received, verificationCode, verificationUrl } = (await res.json()).data;
  expect(received).toBe(true);

  await page.goto(verificationUrl);       // or: fill the 6-digit `verificationCode`
  await expect(page.getByText('Email verified')).toBeVisible();
});
```

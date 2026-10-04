# Security

MailForge handles mail that your applications send to *throw-away* addresses on *your* domain, for testing. It is meant for private/internal networks. This document describes the threat model, what is enforced where, and what you must still do yourself.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Becoming an open SMTP relay / spam source | Mailpit only accepts recipients matching `SMTP_ALLOWED_RECIPIENTS_REGEX`; no relay configuration exists; the backend contains no SMTP client at all (tests assert this) |
| Reading other people's test mail | Everything is behind admin login or API key; ids are unguessable UUIDs; mailbox addresses carry a random suffix |
| Hostile email attacking the viewer (XSS, tracking, clickjacking) | Sanitise → sandbox → CSP, see below |
| Stolen credentials | Argon2id passwords, SHA-256-hashed 256-bit API keys and session tokens, revocation, last-used tracking, login throttling |
| Cross-site request forgery | `SameSite=Strict` cookie + per-session CSRF token header + `Origin` check |
| Injection (SQL, header, path) | Parameterised queries only, validated input, sanitised filenames, generated storage paths, header-safe `Content-Disposition` |
| Resource exhaustion | Size limits, rate limits, query timeout, bounded regex execution (in PostgreSQL), mailbox cap, SSE connection cap |
| Data lingering | Mandatory TTLs and retention (default 24 h), automatic cleanup, hard deletes |
| Secrets in Git/logs | `.env` ignored; log redaction; no passwords, keys, cookies or mail bodies logged |

## SMTP security (the important part)

**Allowed domains.** Mail is accepted only for `MAIL_DOMAIN` (comma-separated list). Enforcement happens twice:

1. **At the SMTP session** – Mailpit's `MP_SMTP_ALLOWED_RECIPIENTS` (set from `SMTP_ALLOWED_RECIPIENTS_REGEX`) rejects any `RCPT TO` that does not match, so a spammer gets a `550` immediately and nothing is queued. Keep this regex in sync with `MAIL_DOMAIN`.
2. **At ingestion** – the backend independently discards any recipient outside `MAIL_DOMAIN`, and any address without an *active* mailbox. Expired or non-existent mailboxes receive nothing.

**Relay behaviour.** Mailpit is only a sink: no `MP_SMTP_RELAY_*` options are configured, so it has nowhere to forward mail. MailForge never sends email. `tests/e2e/api-flow.spec.ts` attempts to relay to `victim@gmail.com`, to a sub-domain and to a look-alike domain and asserts a `550` for each; `backend/test/unit/deployment.test.ts` asserts the compose file never enables relay options.

**SMTP authentication.** Not used: Mailpit accepts unauthenticated submissions *because it can only deliver to the capture store*. The control is therefore network reachability, not credentials – keep the SMTP port on the Docker network or loopback (default), or restrict it with a firewall to the hosts that run your applications.

**Firewall rules for a server.** Expose only what is needed:

| Port | Default exposure | Rule |
| --- | --- | --- |
| 80/443 | public (prod overlay, Caddy) | allow from your users' networks (VPN/office ranges preferably) |
| 1025 (or 25) SMTP | loopback only | to receive mail from other hosts: bind `SMTP_BIND_ADDRESS` to a private IP and allow only the source hosts/subnets of your applications; for real internet mail on port 25 allow `tcp/25` from anywhere *only* if the domain is a dedicated test domain (the recipient regex still guarantees nothing but test mailboxes receive mail) |
| 8025 Mailpit UI/API | loopback in dev, **not published** in prod | never expose; it has no authentication in this setup |
| 5432 PostgreSQL, 3000 backend | not published in prod | never expose |

Example (ufw): `ufw default deny incoming; ufw allow 22/tcp; ufw allow 80,443/tcp; ufw allow from 10.0.0.0/24 to any port 1025 proto tcp`.

**Rate and connection limits.** Mailpit exposes no per-IP connection or rate limit, so enforce them at the firewall if the SMTP port is reachable beyond the Docker network, e.g. `iptables -A INPUT -p tcp --dport 1025 -m connlimit --connlimit-above 20 -j REJECT` and `-m hashlimit` for new-connection rates. Limits that *are* enforced by configuration: `MP_SMTP_MAX_RECIPIENTS` (`SMTP_MAX_RECIPIENTS`, 50), `MP_MAX_MESSAGE_SIZE` (`MAX_EMAIL_SIZE_MB`, 20 MB), `MP_MAX_MESSAGES` (500 queued), and the backend's `MAX_EMAIL_SIZE_MB`, `MAX_ATTACHMENT_SIZE_MB`, `MAX_ACTIVE_MAILBOXES`.

**Transport encryption.** Mail between your application and Mailpit is plaintext SMTP unless you configure `MP_SMTP_TLS_CERT/KEY` (and `MP_SMTP_REQUIRE_STARTTLS`). Within a Docker network or loopback this is acceptable for test mail; across a network, enable STARTTLS or use a VPN.

## HTML email handling

All email HTML is hostile. Defence in depth:

1. **Server-side allow-list sanitiser** (`sanitize-html`): removes `script`, `style`, `iframe`, `object`, `embed`, `form`/inputs, SVG/MathML, all `on*` handlers, and every URL scheme except `http`, `https`, `mailto`, `tel` (plus `data:image/png|jpeg|gif|webp` and resolved `cid:` images). Inline `style` attributes are limited to an allow-list of properties and values containing `url(`, `expression`, `@import`, `javascript:` or backslashes are dropped. Links get `target="_blank" rel="noopener noreferrer nofollow"`.
2. **Sandboxed iframe**: the UI never injects email HTML into its own DOM. It loads `GET /api/messages/:id/html` in an `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` – **no `allow-scripts`, no `allow-same-origin`** – so the email gets an opaque origin: no access to cookies, `localStorage` or the parent page, and no script execution even if the sanitiser failed.
3. **Document CSP header** on that response: `default-src 'none'; img-src data:` (remote images blocked by default to stop tracking pixels; the viewer offers an explicit "load remote images" toggle), `style-src 'unsafe-inline'`, `base-uri 'none'`, `form-action 'none'`, plus a `sandbox` directive.
4. **Everything else is text**: subjects, sender names, headers, raw source and filenames are rendered by React as text.
5. **MailForge never fetches a link** from an email; "Open" is an explicit user action to a plain `http(s)` URL.

Attachments are stored outside the application directory under server-generated UUID names with no extension, never executed, served only as `application/octet-stream` downloads with `nosniff` and a sandbox CSP, and subject to `MAX_ATTACHMENT_SIZE_MB`. Filenames are stripped of path components and control characters; every stored path is re-validated to stay inside the storage root before it is opened or deleted.

## Authentication and sessions

* The first admin is created from `ADMIN_EMAIL`/`ADMIN_PASSWORD` when the user table is empty. In production the password must be ≥ 12 characters and not a known default or the process refuses to start. Reset with `docker compose exec -e NEW_PASSWORD='…' backend node backend/dist/scripts/resetAdminPassword.js` (or `NEW_PASSWORD='…' npm run admin:reset-password -w backend` outside Docker); this revokes existing sessions.
* Passwords: Argon2id. Login runs one verification even for unknown users to avoid user enumeration by timing; failures return one generic error. Failed logins are limited per IP (`LOGIN_RATE_LIMIT`).
* Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` automatically when `NODE_ENV=production`, override with `COOKIE_SECURE`); only its SHA-256 is stored; `SESSION_TTL_HOURS` expiry; logout deletes the row.
* API keys: `mf_` + 256 random bits, shown once, stored as SHA-256, revocable, `last_used_at` tracked, accepted only via `Authorization: Bearer`, and unable to create or revoke keys.
* `API_AUTH_ENABLED=false` exists for throw-away local experiments only; the server refuses to start with it in production and logs a warning otherwise.
* **Single tenant:** every authenticated principal can see every mailbox. Do not hand API keys to people who should not read each other's test mail.

## HTTP hardening

`helmet` headers (`nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, …) plus a deny-by-default CSP on the API; `Cache-Control: no-store`; nginx adds a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, …) on the UI; JSON bodies limited to 100 kB; consistent error envelope with no stack traces; `X-Powered-By` removed. Rate limits (all configurable): login, overall API, mailbox creation, message search/listing, raw/attachment downloads.

## Containers

All services run with `no-new-privileges` and `cap_drop: ALL` (PostgreSQL re-adds only the capabilities its entrypoint needs); the backend and frontend run as non-root users with read-only root filesystems; PostgreSQL and the backend publish no ports in production; only Caddy listens on 80/443. Mailpit's image runs as its default user – it handles only transient data and is not published beyond loopback.

## Logging

Structured JSON (pino) with request id, user id, auth type, status and duration. The request serializer logs the path but not the query string, and redaction removes `Authorization`, cookies and any `password`/`token`/`apiKey` fields. Message contents are never logged. Audit entries (login, logout, key create/revoke, mailbox and message deletion, cleanup) are stored in `audit_logs` without secrets.

## Checklist

| Item | Status |
| --- | --- |
| No public disposable-email API | ✅ none referenced anywhere |
| No open SMTP relay | ✅ recipient allow-list, no relay config, no outbound SMTP code; tested |
| API authentication | ✅ every route but `/api/health` and `/api/auth/login`; tested route by route |
| Admin authentication / password hashing | ✅ Argon2id |
| API key hashing | ✅ SHA-256 of 256-bit keys |
| Rate limiting | ✅ login, API, mailbox creation, search, downloads |
| Input validation | ✅ zod on every body/query, uuid checks on ids |
| SQL injection | ✅ parameterised; hostile payload tests |
| XSS / HTML sanitisation | ✅ sanitiser + sandbox + CSP; hostile payload tests |
| CSRF | ✅ token + Origin check + SameSite=Strict |
| Path traversal | ✅ generated paths, resolve-and-verify, filename sanitising; tested |
| Attachment / email size limits | ✅ `MAX_ATTACHMENT_SIZE_MB`, `MAX_EMAIL_SIZE_MB` |
| Secure cookies, security headers | ✅ |
| No secrets in Git / logs | ✅ `.env` ignored, `.env.example` only; log redaction |
| Non-root containers | ✅ backend, frontend; ⚠️ Mailpit/Postgres use their image defaults |
| Production config separated | ✅ `docker-compose.prod.yml`, `NODE_ENV=production` validation |

## Known limitations

* **Not validated against Docker in the development of this repository** – see README "Verification status".
* No per-IP SMTP connection/rate limiting inside Mailpit (use the firewall); no SMTP TLS by default.
* Single backend instance (in-process event bus); single tenant.
* Per-user mailbox ownership, 2FA/SSO and password-change UI are not implemented.
* `<style>` blocks in emails are removed (inline styles are kept), so some heavily styled newsletters render plainer than in a real client.

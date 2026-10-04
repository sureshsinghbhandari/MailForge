# Deployment

Two modes. Both use Docker Compose (Compose ≥ 2.24 for the production overlay).

## Mode A — local development (everything on your machine)

```
 your app ──SMTP──► Mailpit :1025 ──► backend ──► PostgreSQL
                         browser ──► nginx :8080 ──► backend
```

```bash
cp .env.example .env            # optional: defaults work without it
docker compose up -d
```

| What | URL / address |
| --- | --- |
| Web UI | http://localhost:8080 (`FRONTEND_PORT`) – log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` (default `admin@mailtest.local` / `dev-admin-password-123`) |
| Backend API | http://localhost:3000/api (`BACKEND_PORT`, development stack only) |
| Mailpit UI (debugging) | http://localhost:8025 (`MAILPIT_WEB_PORT`) |
| SMTP for your app | `localhost:1025` from the host, `mailpit:1025` from other containers on the compose network |

All ports are bound to `127.0.0.1`. The default domain is `mailtest.local`, which is **not publicly routable** – mail can only reach MailForge when your application sends it straight to this SMTP server (which is exactly what you want for local testing). Optionally load sample data (3 mailboxes, 5 messages; never done automatically and refused when `NODE_ENV=production`):

```bash
docker compose exec backend node backend/dist/scripts/seed.js
```

### Without Docker

```bash
npm install
cp .env.example .env            # set DATABASE_URL=pglite://./data/pg  (embedded PostgreSQL, no install needed)
npm run seed                    # sample mailboxes/messages (refuses NODE_ENV=production)
npm run dev:backend             # http://localhost:3000
npm run dev:frontend            # http://localhost:5173 (proxies /api to :3000)
```
You still need an SMTP capture server for real mail: run Mailpit (`mailpit` binary or Docker) on 1025/8025, or `npm run fake-mailpit -w tests` for the Mailpit-compatible stand-in (SMTP 11025, HTTP 18025; set `MAILPIT_API_URL=http://127.0.0.1:18025`).

## Mode B — private server

```
 internal apps / VPN ──► (optional) SMTP :1025/:25 ──► Mailpit ──► backend ──► PostgreSQL
 browsers / CI ──► HTTPS :443 (Caddy) ──► nginx ──► backend
```

1. Pick a host (a VM on your private network is ideal), install Docker, and clone the repository.
2. Create `.env` with **real secrets** – compose refuses to start without them:

   ```ini
   NODE_ENV=production
   PUBLIC_HOSTNAME=mail-test.internal.example.com
   POSTGRES_PASSWORD=<long random>
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD=<12+ chars, not a default>
   MAIL_DOMAIN=mailtest.example.com
   SMTP_ALLOWED_RECIPIENTS_REGEX='^[^@\s]+@(mailtest\.example\.com)$'
   ```
3. Start: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
4. Check: `docker compose ps` (all healthy), then open `https://$PUBLIC_HOSTNAME`.

What the overlay does: requires secrets; `NODE_ENV=production` (Secure cookies, strict config checks); removes the backend/frontend loopback ports; publishes only **80/443** (Caddy, automatic Let's Encrypt – or add `tls internal` to `deploy/Caddyfile` for an internal CA); keeps Mailpit's web UI and PostgreSQL unpublished.

**Receiving mail from other machines.** By default SMTP is published on loopback only. If applications on *other* hosts must deliver mail, set `SMTP_BIND_ADDRESS` to this host's **private** IP (not `0.0.0.0` on a public host) and firewall port 1025 to those hosts (see [SECURITY.md](SECURITY.md)). To accept mail on the standard port 25 set `MAILPIT_SMTP_PORT=25`.

## DNS setup (you configure it; MailForge never touches DNS)

To receive mail from the internet for `mailtest.example.com` (skip this if your apps send to MailForge directly over a private network):

| Record | Example | Purpose |
| --- | --- | --- |
| `A` / `AAAA` | `mx.mailtest.example.com. A 203.0.113.10` | Address of the server running the SMTP port. Must be a real hostname with an address record, not a CNAME |
| `MX` | `mailtest.example.com. MX 10 mx.mailtest.example.com.` | Tells senders where to deliver mail for the domain. **The only record strictly required for receiving** |
| `SPF` (TXT) | `mailtest.example.com. TXT "v=spf1 -all"` | MailForge sends no mail, so declare that nobody may send as this domain – stops spoofing of your test domain |
| `DKIM` (TXT) | *none* | Signs *outgoing* mail; a receive-only domain has nothing to sign. Add it only if you later send from this domain |
| `DMARC` (TXT) | `_dmarc.mailtest.example.com. TXT "v=DMARC1; p=reject; adkim=s; aspf=s"` | Tells receivers to reject spoofed mail from your domain |
| `A` for the web UI | `mail-test.internal.example.com. A <host>` | Name for `PUBLIC_HOSTNAME`; internal DNS is fine |

Also open the SMTP port in the firewall and make sure your hosting provider allows inbound port 25. Use a **dedicated subdomain** so test traffic never mixes with production mail. Remember to keep `MAIL_DOMAIN` and `SMTP_ALLOWED_RECIPIENTS_REGEX` identical in meaning.

## Sending a test email

```js
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,   // localhost (from the host), mailpit (from compose), or your server
  port: 1025,
  secure: false,
});

await transporter.sendMail({
  from: 'noreply@example.com',
  to: 'test-a8f72c@mailtest.local',      // an address you created in MailForge
  subject: 'Verify your account',
  text: 'Your verification code is 482913',
});
```
Mail to an address that does not exist (or has expired) is accepted at the SMTP level (if the domain matches) and then discarded.

## Backups

* `scripts/backup-db.sh [dir]` – compressed `pg_dump` of the running stack; prunes dumps older than `BACKUP_RETENTION_DAYS` (default 7).
* `scripts/restore-db.sh <dump.sql.gz>` – destructive restore (asks you to type `restore`); stop the backend first.
* Cron example: `15 3 * * * cd /opt/mailforge && COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml scripts/backup-db.sh /var/backups/mailforge`.
* Mailbox and message data is intentionally short-lived (default 24 h retention); backups mostly protect users, API-key hashes and the audit log. Attachment files live in the `attachments` volume and are not part of the dump – they are also temporary by design. Don't keep backups of temporary test mail longer than your policy allows.

## Data retention

`MAILBOX_RETENTION_HOURS`, `MESSAGE_RETENTION_HOURS`, `ATTACHMENT_RETENTION_HOURS` (default 24 each) and `CLEANUP_INTERVAL_SECONDS` (60). Expired data is removed permanently by the cleanup worker; see [ARCHITECTURE.md](ARCHITECTURE.md#lifecycle-and-retention).

## Upgrades

`git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. Database migrations in `database/migrations/` run automatically at backend start (each in a transaction, recorded in `schema_migrations`). Take a backup first.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `docker compose up` says a variable is required | You are using the prod overlay – set it in `.env` |
| Backend unhealthy / UI shows SMTP "unhealthy" | `docker compose logs mailpit backend`; the backend reaches Mailpit at `http://mailpit:8025` |
| Sending mail fails with `550` | The recipient is outside `MAIL_DOMAIN` / `SMTP_ALLOWED_RECIPIENTS_REGEX`, or the SMTP host/port is wrong |
| Mail sent but nothing in the inbox | The mailbox must exist and be unexpired *before* sending; check the backend log line `captured message discarded` (reason `no_matching_mailbox`) |
| Cannot log in behind HTTPS | Cookies are `Secure` in production; use HTTPS, or set `COOKIE_SECURE=false` for plain-HTTP LAN testing only |
| "Cross-origin request rejected" | The browser's `Origin` differs from the `Host` the backend sees – make your proxy pass `Host`, or list the origin in `ALLOWED_ORIGINS` |
| Too many requests (429) | Raise the relevant `*_RATE_LIMIT` |
| Everyone shares one rate-limit bucket | `TRUST_PROXY` must equal the number of proxies in front of the backend (dev: 1, prod overlay: 2) |

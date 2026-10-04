# Receiving real email (Gmail, Outlook/Office 365, …)

`mailtest.local` only works for mail you send straight to the SMTP port. To let **anyone on the internet** (a Gmail account, an Office mailbox, a SaaS product) send to your mailboxes, three things must be true:

1. You own a **domain** whose DNS you can edit.
2. An **MX record** for it points to a **server with a public IP**.
3. That server accepts **inbound TCP port 25** and runs MailForge.

Nothing about MailForge's design changes: the same Mailpit → backend pipeline receives the mail. You are only adding public DNS, a reachable port and TLS. Everything stays on your own server – no third-party mail service.

> **A PC at home usually cannot do this.** Residential ISPs commonly block port 25, addresses change, the router uses NAT, and an MX record cannot point at a different port. Use a small cloud VM or a server at your office with a public IP.

## 1. Get a domain

Buy any domain from a registrar that lets you edit DNS records (roughly 10 USD/year). A **dedicated subdomain** keeps test mail away from anything else: e.g. you own `example.com` and use `t.example.com` as `MAIL_DOMAIN`, so mailboxes look like `test-a8f72c@t.example.com`. Free-subdomain DNS services exist, but many don't allow MX records or have poor reputations with big mail providers; a paid domain is far less trouble.

## 2. Get a server

* Linux VM with a **public IPv4 address**, 1 vCPU / 1–2 GB RAM is plenty, Docker + Docker Compose ≥ 2.24 installed.
* **Inbound port 25 must be open.** Several large clouds restrict port 25 by default (usually *outbound*, sometimes both) – check your provider's policy and its security-group/firewall settings. You only need **inbound**; MailForge never sends mail. The checker in step 6 tells you for sure.

## 3. DNS records

Replace `example.com`, `t.example.com` and `203.0.113.10` (your server's public IP).

| Name | Type | Value | Why |
| --- | --- | --- | --- |
| `mail.example.com` | `A` | `203.0.113.10` | The mail server's name (also the web UI name). Add an `AAAA` only if the server really accepts IPv6 on port 25 |
| `t.example.com` | `MX` | `10 mail.example.com.` | **Required.** Tells Gmail/Office where to deliver mail for `@t.example.com` |
| `t.example.com` | `TXT` | `"v=spf1 -all"` | Optional: this domain never sends mail, so nobody may spoof it |
| `_dmarc.t.example.com` | `TXT` | `"v=DMARC1; p=reject"` | Optional: same purpose |

An MX must point to a host with an **A/AAAA record, never a CNAME**. DNS changes can take minutes to hours. No DKIM record is needed: DKIM signs *outgoing* mail.

## 4. Configure and start MailForge on the server

```bash
git clone https://github.com/sureshsinghbhandari/MailForge.git /opt/mailforge && cd /opt/mailforge
cp .env.example .env
```

If the GitHub repository is private, give the server read access first: add a read-only **deploy key** (Repository → Settings → Deploy keys) and clone with the `git@github.com:sureshsinghbhandari/MailForge.git` URL, or use a fine-grained personal access token. To update later: `git pull` and re-run the `docker compose … up -d --build` command.

Edit `.env` (replace every value; `.env` is git-ignored and stays only on the server):

```ini
NODE_ENV=production
PUBLIC_HOSTNAME=mail.example.com            # web UI name; Caddy gets a Let's Encrypt certificate for it
POSTGRES_PASSWORD=<long random>
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<12+ characters, not a default>

MAIL_DOMAIN=t.example.com
SMTP_ALLOWED_RECIPIENTS_REGEX='^[^@\s]+@(t\.example\.com)$'

# Accept mail from the internet on the standard port:
SMTP_BIND_ADDRESS=0.0.0.0
MAILPIT_SMTP_PORT=25
```

Firewall (example with ufw – also open the same ports in your cloud provider's security group):

```bash
ufw default deny incoming
ufw allow 22/tcp          # SSH (restrict to your IP if you can)
ufw allow 80,443/tcp      # web UI + certificate issuance
ufw allow 25/tcp          # inbound mail
ufw enable
```

Start it:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Open `https://mail.example.com`, log in, and create a mailbox.

### Optional but recommended: TLS on port 25

Gmail will deliver without TLS, but many corporate (Office 365 / Exchange) senders **require** TLS and will bounce or queue mail to a server that doesn't offer it. After the web UI has loaded once over HTTPS (so Caddy has its certificate):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.smtp-tls.yml up -d
```

This reuses Caddy's certificate for SMTP (STARTTLS is offered, not forced). Restart Mailpit about monthly so it picks up renewed certificates: `docker compose restart mailpit`.

## 5. Safety of a public SMTP port

* **It cannot be used as a relay.** Mailpit rejects (`550`) every recipient outside your domain, has no relay configuration, and MailForge never sends mail. The checker below proves this from the outside.
* **Anyone can send to a mailbox that exists** – that is the point. Addresses carry a random suffix (`test-a8f72c@…`), mailboxes expire (default 60 minutes), and data is purged automatically (24 h retention by default), so there is little to find or abuse.
* Mail to an address with no mailbox is accepted and **silently discarded**; MailForge never sends bounce messages, so it can't be used for backscatter.
* Expect some spam on a public MX over time; it only fills mailboxes that exist. Add connection limits at the firewall if needed (`iptables … -m connlimit`, see [SECURITY.md](SECURITY.md)).
* Keep the web UI behind a VPN/IP allow-list if you can; only port 25 needs to be open to the world.

## 6. Verify from the outside

Run the checker from a machine **other than the server** (a laptop on a network that allows outbound port 25, or another VM) – it never sends a message:

```bash
node scripts/check-inbound.mjs t.example.com
# optional: --mailbox test-a8f72c@t.example.com   to probe a specific address
```

It verifies the MX and A records, that port 25 is reachable, the SMTP banner and STARTTLS, that an address in your domain is accepted, and that attempts to relay to `gmail.com` and look-alike domains are **rejected**. Fix any ✗ before sending real mail. (From a home network the check may fail simply because your ISP blocks outbound port 25; run it from a VM instead, or use an online "SMTP port 25 test".)

Then send a real message from Gmail or your Office account to the mailbox you created. It should appear in the inbox within seconds. If it doesn't:

| Symptom | Likely cause |
| --- | --- |
| Gmail shows "address not found" / "domain doesn't exist" | MX record missing or not yet propagated (`dig MX t.example.com`) |
| Gmail "delayed, will keep trying" | Port 25 unreachable (firewall, security group, provider block); Gmail retries for days, so once fixed the mail may still arrive |
| Mail accepted but not shown | The mailbox did not exist or had expired when it arrived (backend log: `captured message discarded … no_matching_mailbox`); create the mailbox first, then send |
| Office/Exchange bounces with a TLS error | Enable the optional TLS override above |
| `550` from your own server | The recipient is outside `MAIL_DOMAIN` / `SMTP_ALLOWED_RECIPIENTS_REGEX` – they must describe the same domain |
| Verification codes/links not detected | Check the message in the *Text*/*Raw* tab; add keywords with `VERIFICATION_CODE_KEYWORDS` |

## What I could not test

This guide and the TLS override were written without a public server or domain: the checker was exercised against the local stack and error cases, and the rest follows the documented behaviour of Mailpit, Caddy and the mail standards. Run the checker on your first deployment and treat any ✗ as authoritative.

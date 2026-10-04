#!/usr/bin/env node
/**
 * Checks whether MailForge can receive real internet mail for a domain, WITHOUT sending any mail.
 *
 *   node scripts/check-inbound.mjs mailtest.example.com
 *   node scripts/check-inbound.mjs mailtest.example.com --mailbox test-abc123@mailtest.example.com
 *   node scripts/check-inbound.mjs mailtest.local --skip-dns --host 127.0.0.1 --port 11025   (local stack)
 *
 * Checks: MX/A records -> TCP reachability of the SMTP port -> banner / STARTTLS -> a RCPT TO for your
 * domain is accepted -> a RCPT TO for an outside domain is REJECTED (open-relay test) -> SPF/DMARC hints.
 * It stops before DATA, so nothing is ever delivered. Run it from a machine OUTSIDE the server (and not
 * on a home connection that blocks outbound port 25) to prove the internet can reach you.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const args = process.argv.slice(2);
const domain = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--host' && args[args.indexOf(a) - 1] !== '--port' && args[args.indexOf(a) - 1] !== '--mailbox');
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!domain) {
  console.error('usage: check-inbound.mjs <mail-domain> [--host <smtp-host>] [--port 25] [--mailbox <address>] [--skip-dns]');
  process.exit(2);
}
const port = Number(opt('port') ?? 25);
const mailbox = opt('mailbox') ?? `mailforge-check@${domain}`;

let failures = 0;
let warnings = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};
const warn = (m) => {
  warnings += 1;
  console.log(`  ! ${m}`);
};

/** Minimal SMTP dialogue: sends a command, returns { code, lines }. */
function smtpSession(host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 15_000 });
    let buffer = '';
    let waiter = null;
    const flush = () => {
      if (!waiter) return;
      const lines = buffer.split('\r\n');
      const complete = lines.length > 1 ? lines.slice(0, -1) : [];
      const last = complete[complete.length - 1];
      if (last && /^\d{3} /.test(last)) {
        buffer = lines[lines.length - 1];
        const w = waiter;
        waiter = null;
        w({ code: Number(last.slice(0, 3)), lines: complete });
      }
    };
    socket.on('data', (d) => {
      buffer += d.toString('latin1');
      flush();
    });
    socket.on('timeout', () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () =>
      resolve({
        read: () => new Promise((r) => ((waiter = r), flush())),
        send: (line) => {
          socket.write(`${line}\r\n`);
          return new Promise((r) => ((waiter = r), flush()));
        },
        close: () => socket.destroy(),
      }),
    );
  });
}

console.log(`Checking inbound mail for ${domain}\n`);

// 1. DNS -------------------------------------------------------------------------------------
let smtpHost = opt('host');
console.log('DNS');
if (args.includes('--skip-dns')) {
  warn('DNS checks skipped');
} else {
  try {
    const mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    if (mx.length === 0) throw new Error('no MX records');
    pass(`MX: ${mx.map((m) => `${m.exchange} (priority ${m.priority})`).join(', ')}`);
    smtpHost ??= mx[0].exchange;
    for (const m of mx) {
      const addrs = [
        ...(await dns.resolve4(m.exchange).catch(() => [])),
        ...(await dns.resolve6(m.exchange).catch(() => [])),
      ];
      if (addrs.length) pass(`${m.exchange} resolves to ${addrs.join(', ')}`);
      else fail(`${m.exchange} has no A/AAAA record (an MX must point at a host with an address record, not a CNAME)`);
    }
  } catch (err) {
    fail(`no usable MX record for ${domain} (${err.code ?? err.message}). Senders have nowhere to deliver mail.`);
  }
  const txt = async (name) => (await dns.resolveTxt(name).catch(() => [])).map((r) => r.join(''));
  const spf = (await txt(domain)).find((t) => t.startsWith('v=spf1'));
  if (spf) pass(`SPF: ${spf}`);
  else warn('no SPF record (optional for a receive-only domain; "v=spf1 -all" is recommended)');
  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => t.startsWith('v=DMARC1'));
  if (dmarc) pass(`DMARC: ${dmarc}`);
  else warn('no DMARC record (optional; "v=DMARC1; p=reject" is recommended for a receive-only domain)');
}

if (!smtpHost) {
  console.log('\nCannot continue without an SMTP host.');
  process.exit(1);
}

// 2. SMTP ------------------------------------------------------------------------------------
console.log(`\nSMTP ${smtpHost}:${port}`);
let session;
try {
  session = await smtpSession(smtpHost);
} catch (err) {
  fail(`cannot connect: ${err.code ?? err.message}. Check the server firewall / cloud security group, that MailForge publishes the port, and that your provider allows port 25.`);
  console.log(`\n${failures} problem(s). Mail from the internet will NOT arrive.`);
  process.exit(1);
}
try {
  const banner = await session.read();
  if (banner.code === 220) pass(`banner: ${banner.lines[0]}`);
  else fail(`unexpected banner: ${banner.lines.join(' | ')}`);

  const ehlo = await session.send('EHLO mailforge-check.invalid');
  if (ehlo.code === 250) pass('EHLO accepted');
  else fail(`EHLO rejected: ${ehlo.lines.join(' | ')}`);
  if (/STARTTLS/i.test(ehlo.lines.join('\n'))) pass('STARTTLS offered (senders such as Gmail will encrypt)');
  else warn('STARTTLS not offered: mail is accepted but travels unencrypted (see docs/RECEIVING-EXTERNAL-EMAIL.md to add a certificate)');

  const from = await session.send('MAIL FROM:<mailforge-check@example.org>');
  if (from.code === 250) pass('MAIL FROM accepted');
  else fail(`MAIL FROM rejected: ${from.lines.join(' | ')}`);

  const own = await session.send(`RCPT TO:<${mailbox}>`);
  if (own.code === 250) pass(`recipient inside ${domain} accepted`);
  else fail(`recipient ${mailbox} was rejected (${own.lines.join(' | ')}): is MAIL_DOMAIN / SMTP_ALLOWED_RECIPIENTS_REGEX set for this domain?`);
  await session.send('RSET');
  await session.send('MAIL FROM:<mailforge-check@example.org>');

  for (const outside of ['relay-check@gmail.com', `relay-check@sub.${domain}`, `relay-check@${domain}.example.net`]) {
    const res = await session.send(`RCPT TO:<${outside}>`);
    if (res.code >= 500) pass(`relay attempt to ${outside} rejected (${res.code})`);
    else fail(`OPEN RELAY RISK: ${outside} was accepted (${res.code}). Fix SMTP_ALLOWED_RECIPIENTS_REGEX before exposing this port!`);
  }
  await session.send('QUIT').catch(() => undefined);
} catch (err) {
  fail(`SMTP dialogue failed: ${err.message}`);
} finally {
  session.close();
}

console.log(
  failures === 0
    ? `\nOK${warnings ? ` (${warnings} advisory note${warnings > 1 ? 's' : ''})` : ''}: ${domain} looks ready to receive real email.`
    : `\n${failures} problem(s) found.`,
);
process.exit(failures === 0 ? 0 : 1);

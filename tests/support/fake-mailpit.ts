/**
 * A tiny stand-in for Mailpit used when Docker is unavailable (e.g. on a laptop without Docker Desktop).
 * It speaks real SMTP (via smtp-server) and exposes the subset of Mailpit's HTTP API the backend uses:
 *   GET /livez, GET /api/v1/messages, GET /api/v1/message/:id/raw, DELETE /api/v1/messages {IDs}
 * and mimics MP_SMTP_ALLOWED_RECIPIENTS: RCPT TO outside the allowed pattern is rejected with 550.
 *
 * It is NOT Mailpit: the real-Mailpit behaviour is only covered by running the Docker stack.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { SMTPServer } from 'smtp-server';

export interface CapturedMessage {
  id: string;
  raw: Buffer;
  recipients: string[];
  created: Date;
}

export interface FakeMailpit {
  smtpPort: number;
  httpPort: number;
  messages: Map<string, CapturedMessage>;
  close(): Promise<void>;
}

export interface FakeMailpitOptions {
  smtpPort: number;
  httpPort: number;
  allowedRecipients: RegExp;
  maxSizeBytes?: number;
}

export async function startFakeMailpit(opts: FakeMailpitOptions): Promise<FakeMailpit> {
  const messages = new Map<string, CapturedMessage>();

  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: opts.maxSizeBytes ?? 20 * 1024 * 1024,
    logger: false,
    onRcptTo(address, _session, callback) {
      if (!opts.allowedRecipients.test(address.address)) {
        return callback(Object.assign(new Error('Relay access denied'), { responseCode: 550 }));
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const id = randomUUID();
        messages.set(id, {
          id,
          raw: Buffer.concat(chunks),
          recipients: session.envelope.rcptTo.map((r) => r.address.toLowerCase()),
          created: new Date(),
        });
        callback();
      });
    },
  });

  const web = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/livez' || url.pathname === '/readyz') return void res.end('ok');

    if (url.pathname === '/api/v1/messages' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const newestFirst = [...messages.values()].sort((a, b) => b.created.getTime() - a.created.getTime());
      return json(200, {
        total: messages.size,
        count: Math.min(limit, messages.size),
        messages: newestFirst.slice(0, limit).map((m) => ({
          ID: m.id,
          Size: m.raw.length,
          Created: m.created.toISOString(),
          To: m.recipients.map((Address) => ({ Name: '', Address })),
          Cc: null,
          Bcc: null,
        })),
      });
    }

    const raw = /^\/api\/v1\/message\/([^/]+)\/raw$/.exec(url.pathname);
    if (raw && req.method === 'GET') {
      const m = messages.get(decodeURIComponent(raw[1] as string));
      if (!m) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(m.raw);
    }

    if (url.pathname === '/api/v1/messages' && req.method === 'DELETE') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ids = (JSON.parse(body || '{}') as { IDs?: string[] }).IDs ?? [];
        for (const id of ids) messages.delete(id);
        res.end('ok');
      });
      return;
    }
    json(404, { error: 'not found' });
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      smtp.once('error', reject);
      smtp.listen(opts.smtpPort, '127.0.0.1', resolve);
    }),
    new Promise<void>((resolve) => web.listen(opts.httpPort, '127.0.0.1', resolve)),
  ]);

  return {
    smtpPort: opts.smtpPort,
    httpPort: opts.httpPort,
    messages,
    close: async () => {
      await new Promise<void>((r) => smtp.close(() => r()));
      web.closeAllConnections();
      await new Promise<void>((r) => web.close(() => r()));
    },
  };
}

// CLI entry: `tsx support/fake-mailpit.ts`
if (import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  const smtpPort = Number(process.env['FAKE_SMTP_PORT'] ?? 11025);
  const httpPort = Number(process.env['FAKE_MAILPIT_HTTP_PORT'] ?? 18025);
  const allowed = new RegExp(process.env['SMTP_ALLOWED_RECIPIENTS_REGEX'] ?? '^[^@\\s]+@(mailtest\\.local)$');
  const server = await startFakeMailpit({ smtpPort, httpPort, allowedRecipients: allowed });
  console.log(`fake mailpit: smtp 127.0.0.1:${server.smtpPort}, http 127.0.0.1:${server.httpPort}`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

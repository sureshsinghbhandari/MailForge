/**
 * Serves the built frontend (frontend/dist) the way frontend/nginx.conf does, so the e2e test exercises
 * the production Content-Security-Policy and the /api reverse proxy (including unbuffered SSE):
 *   - static files + SPA fallback, security headers taken VERBATIM from nginx.conf,
 *   - /api/* proxied to the backend with the original Host header.
 * It is a test double for nginx, not a deployment artifact.
 */
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '..', 'frontend', 'dist');
const nginx = readFileSync(path.resolve(here, '..', '..', 'frontend', 'nginx.conf'), 'utf8');

// Headers from the `location /` block: add_header NAME "VALUE" always;
const staticHeaders: Record<string, string> = {};
const locationRoot = nginx.slice(nginx.indexOf('location / {'));
for (const m of locationRoot.slice(0, locationRoot.indexOf('}')).matchAll(/add_header\s+(\S+)\s+"([^"]*)"\s+always;/g)) {
  staticHeaders[m[1] as string] = m[2] as string;
}
if (!staticHeaders['Content-Security-Policy']) throw new Error('could not read CSP from frontend/nginx.conf');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const port = Number(process.env['PORT'] ?? 4173);
const backend = new URL(process.env['BACKEND_URL'] ?? 'http://127.0.0.1:3000');

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const upstream = http.request(
      {
        host: backend.hostname,
        port: backend.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res); // unbuffered: required for Server-Sent Events
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end('bad gateway');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
    return;
  }

  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { ...staticHeaders, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => console.log(`prod-like frontend on http://127.0.0.1:${port} -> ${backend.origin}`));

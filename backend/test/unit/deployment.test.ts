import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// `yaml` does not know Compose's !override / !reset tags; they only affect merging, not the shape we assert on.
const load = async (file: string) =>
  parse((await readFile(path.join(root, file), 'utf8')).replace(/ !(override|reset)/g, ''), { merge: true }) as Compose;

interface Service {
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  cap_drop?: string[];
  security_opt?: string[];
  read_only?: boolean;
  user?: string;
}
interface Compose {
  services: Record<string, Service>;
}

describe('docker-compose.yml (open relay and exposure guarantees)', () => {
  it('publishes ports on loopback only and never exposes PostgreSQL', async () => {
    const compose = await load('docker-compose.yml');
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const port of svc.ports ?? []) {
        expect(port, `${name} publishes ${port}`).toMatch(/^127\.0\.0\.1:/);
      }
    }
    expect(compose.services['postgres']?.ports).toBeUndefined();
    expect(Object.keys(compose.services).sort()).toEqual(['backend', 'frontend', 'mailpit', 'postgres']);
  });

  it('restricts SMTP recipients and configures no relay or SMTP auth bypass', async () => {
    const env = (await load('docker-compose.yml')).services['mailpit']?.environment ?? {};
    expect(env['MP_SMTP_ALLOWED_RECIPIENTS']).toBeTruthy();
    const regex = new RegExp(String(env['MP_SMTP_ALLOWED_RECIPIENTS']).replace(/^\$\{[A-Z_]+:-/, '').replace(/\}$/, '').replace(/\$\$/g, '$'));
    expect(regex.test('test-abc123@mailtest.local')).toBe(true);
    for (const outside of ['victim@gmail.com', 'a@mailtest.local.evil.com', 'a@sub.mailtest.local', 'a@b@mailtest.local x']) {
      expect(regex.test(outside), outside).toBe(false);
    }
    const keys = Object.keys(env).join(' ');
    expect(keys).not.toMatch(/RELAY/);
    expect(keys).not.toMatch(/AUTH_ACCEPT_ANY/);
    expect(env['MP_SMTP_IGNORE_REJECTED_RECIPIENTS']).toBeUndefined();
  });

  it('hardens containers', async () => {
    const compose = await load('docker-compose.yml');
    for (const name of ['backend', 'frontend', 'mailpit']) {
      expect(compose.services[name]?.cap_drop, name).toEqual(['ALL']);
      expect(compose.services[name]?.security_opt, name).toContain('no-new-privileges:true');
    }
    expect(compose.services['backend']?.read_only).toBe(true);
  });
});

describe('docker-compose.prod.yml', () => {
  it('requires secrets, runs in production mode and exposes only the TLS proxy', async () => {
    const raw = await readFile(path.join(root, 'docker-compose.prod.yml'), 'utf8');
    expect(raw).toContain('POSTGRES_PASSWORD:?');
    expect(raw).toContain('ADMIN_PASSWORD:?');
    expect(raw).toContain('NODE_ENV: production');
    const compose = await load('docker-compose.prod.yml');
    const published = Object.entries(compose.services).flatMap(([name, svc]) => (svc.ports ?? []).map((p) => `${name}:${p}`));
    // Only the proxy listens publicly; Mailpit SMTP stays on loopback unless SMTP_BIND_ADDRESS is set.
    expect(published.filter((p) => !p.startsWith('mailpit:') && !p.startsWith('proxy:'))).toEqual([]);
    expect(published.filter((p) => p.startsWith('proxy:')).sort()).toEqual(['proxy:443:443', 'proxy:80:80']);
    expect(published.find((p) => p.startsWith('mailpit:'))).toContain('${SMTP_BIND_ADDRESS:-127.0.0.1}');
    expect(published.join(' ')).not.toContain('8025');
  });
});

describe('docker-compose.smtp-tls.yml', () => {
  it('only adds certificates: no published ports, no relay settings', async () => {
    const compose = await load('docker-compose.smtp-tls.yml');
    const mailpit = compose.services['mailpit'];
    expect(mailpit?.ports).toBeUndefined();
    expect(Object.keys(mailpit?.environment ?? {}).join(' ')).not.toMatch(/RELAY|ALLOWED_RECIPIENTS/);
    expect(mailpit?.environment?.['MP_SMTP_REQUIRE_STARTTLS']).toBe('false');
  });
});

describe('.env.example', () => {
  it('documents every variable the config schema accepts without committing secrets', async () => {
    const example = await readFile(path.join(root, '.env.example'), 'utf8');
    const config = await readFile(path.join(root, 'backend', 'src', 'config.ts'), 'utf8');
    const schemaVars = [...config.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string);
    expect(schemaVars.length).toBeGreaterThan(30);
    const missing = schemaVars.filter((v) => !new RegExp(`^#?\\s*${v}=`, 'm').test(example));
    expect(missing).toEqual([]);
  });

  it('is the only env file that is not git-ignored', async () => {
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });
});

describe('docs/openapi.yaml', () => {
  it('documents exactly the routes the server mounts', async () => {
    const prefixes: Record<string, string> = {
      'auth.ts': '/api/auth',
      'mailboxes.ts': '/api/mailboxes',
      'messages.ts': '/api/messages',
      'test.ts': '/api/test',
      'system.ts': '/api',
    };
    const implemented = new Set<string>(['GET /api/health']);
    for (const [file, prefix] of Object.entries(prefixes)) {
      const src = await readFile(path.join(root, 'backend', 'src', 'http', 'routes', file), 'utf8');
      for (const m of src.matchAll(/router\.(get|post|patch|delete)\(\s*'([^']*)'/g)) {
        const route = (prefix + (m[2] === '/' ? '' : (m[2] as string))).replace(/:(\w+)/g, '{$1}');
        implemented.add(`${(m[1] as string).toUpperCase()} ${route}`);
      }
    }
    const spec = parse(await readFile(path.join(root, 'docs', 'openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = new Set<string>();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (['get', 'post', 'patch', 'delete'].includes(method)) documented.add(`${method.toUpperCase()} ${p}`);
      }
    }
    expect([...implemented].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !implemented.has(r)).sort()).toEqual([]);
  });
});

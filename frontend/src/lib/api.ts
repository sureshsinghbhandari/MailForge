import type { ListMeta } from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ApiResult<T> {
  data: T;
  meta?: ListMeta | undefined;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Query;
  body?: unknown;
  /** Do not treat a 401 as "session lost" (used by login and the initial /auth/me probe). */
  skipUnauthorizedHandler?: boolean;
  signal?: AbortSignal;
}

// The CSRF token lives in memory only (never localStorage): a reload re-fetches it from /auth/me.
let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function notifyUnauthorized(status: number, opts: RequestOptions): void {
  if (status === 401 && !opts.skipUnauthorizedHandler) unauthorizedHandler?.();
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}${buildQuery(opts.query)}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.', 0);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok || !isRecord(json) || json['success'] !== true) {
    notifyUnauthorized(res.status, opts);
    const err = isRecord(json) && isRecord(json['error']) ? json['error'] : null;
    throw new ApiError(
      typeof err?.['code'] === 'string' ? err['code'] : 'HTTP_ERROR',
      typeof err?.['message'] === 'string' ? err['message'] : `Request failed with status ${res.status}`,
      res.status,
      err?.['details'],
    );
  }
  return { data: json['data'] as T, meta: json['meta'] as ListMeta | undefined };
}

/** Fetches a plain-text endpoint (e.g. the raw message source). */
export async function requestText(path: string, opts: Pick<RequestOptions, 'query' | 'signal'> = {}): Promise<string> {
  const init: RequestInit = { credentials: 'same-origin' };
  if (opts.signal) init.signal = opts.signal;
  let res: Response;
  try {
    res = await fetch(`/api${path}${buildQuery(opts.query)}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok) {
    notifyUnauthorized(res.status, {});
    let message = `Request failed with status ${res.status}`;
    let code = 'HTTP_ERROR';
    try {
      const json: unknown = await res.json();
      if (isRecord(json) && isRecord(json['error'])) {
        if (typeof json['error']['message'] === 'string') message = json['error']['message'];
        if (typeof json['error']['code'] === 'string') code = json['error']['code'];
      }
    } catch {
      /* not JSON */
    }
    throw new ApiError(code, message, res.status);
  }
  return res.text();
}

export const api = {
  get: <T>(path: string, query?: Query, extra: Partial<RequestOptions> = {}) =>
    request<T>(path, { ...extra, method: 'GET', ...(query ? { query } : {}) }),
  post: <T>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}) =>
    request<T>(path, { ...extra, method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', ...(query ? { query } : {}) }),
};

/** URL of the sandboxed, server-sanitised HTML rendering of a message (served with its own strict CSP). */
export function emailFrameUrl(messageId: string, allowRemoteImages: boolean): string {
  return `/api/messages/${encodeURIComponent(messageId)}/html${allowRemoteImages ? '?images=true' : ''}`;
}

export const rawDownloadUrl = (id: string) => `/api/messages/${encodeURIComponent(id)}/raw?download=true`;
export const attachmentUrl = (id: string, attachmentId: string) =>
  `/api/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;

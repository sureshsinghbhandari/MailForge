import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, emailFrameUrl, setCsrfToken, setUnauthorizedHandler } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('csrf-123');
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
    setUnauthorizedHandler(null);
  });

  it('unwraps data and returns meta for lists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 'a' }], meta: { page: 2, pageSize: 25, total: 60 } }));
    const res = await api.get<Array<{ id: string }>>('/messages', { page: 2, search: 'hi there', empty: '' });
    expect(res.data).toEqual([{ id: 'a' }]);
    expect(res.meta).toEqual({ page: 2, pageSize: 25, total: 60 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/messages?page=2&search=hi+there');
    expect(init.credentials).toBe('same-origin');
  });

  it('throws ApiError carrying code, message, status and details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'INVALID_PREFIX', message: 'prefix is bad', details: [{ path: 'prefix' }] } }, 400),
    );
    const err = await api.post('/mailboxes', { prefix: 'X' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'INVALID_PREFIX', message: 'prefix is bad', status: 400, details: [{ path: 'prefix' }] });
  });

  it('falls back to a generic error for non-JSON failures and network errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api.get('/dashboard')).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 502 });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.get('/dashboard')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('sends X-CSRF-Token only on non-GET requests', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ success: true, data: {} })));
    await api.get('/dashboard');
    await api.post('/mailboxes', {});
    await api.patch('/messages/1', { isRead: true });
    await api.delete('/messages/1');
    const headers = fetchMock.mock.calls.map(([, init]) => (init?.headers ?? {}) as Record<string, string>);
    expect(headers[0]?.['X-CSRF-Token']).toBeUndefined();
    expect(headers[1]?.['X-CSRF-Token']).toBe('csrf-123');
    expect(headers[2]?.['X-CSRF-Token']).toBe('csrf-123');
    expect(headers[3]?.['X-CSRF-Token']).toBe('csrf-123');
  });

  it('calls the unauthorised handler on 401, except for calls that opt out', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const unauth = () => jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

    fetchMock.mockResolvedValueOnce(unauth());
    await expect(api.get('/dashboard')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(handler).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(unauth());
    await expect(api.post('/auth/login', {}, { skipUnauthorizedHandler: true })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('emailFrameUrl', () => {
  it('points at the server-sanitised document and toggles remote images via the query string', () => {
    expect(emailFrameUrl('abc', false)).toBe('/api/messages/abc/html');
    expect(emailFrameUrl('abc', true)).toBe('/api/messages/abc/html?images=true');
  });

  it('encodes the id so it cannot alter the path', () => {
    expect(emailFrameUrl('a/../b?x=1', false)).toBe('/api/messages/a%2F..%2Fb%3Fx%3D1/html');
  });
});

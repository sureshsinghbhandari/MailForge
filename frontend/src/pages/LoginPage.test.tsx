import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthProvider';
import { setCsrfToken, setUnauthorizedHandler } from '../lib/api';
import { LoginPage } from './LoginPage';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const unauthorized = () => json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);

function setup() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Signed-in home</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
    setUnauthorizedHandler(null);
  });

  it('shows the server error message in a role=alert region', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(unauthorized()) // /auth/me probe
      .mockResolvedValueOnce(json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401));
    setup();

    await user.type(await screen.findByLabelText('Email'), 'admin@mailtest.local');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('posts credentials to /api/auth/login and navigates home on success', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ success: true, data: { user: { id: 'u1', email: 'admin@mailtest.local' }, csrfToken: 'tok' } }));
    setup();

    await user.type(await screen.findByLabelText('Email'), 'admin@mailtest.local');
    await user.type(screen.getByLabelText('Password'), 'dev-password-12345');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByText('Signed-in home')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'admin@mailtest.local', password: 'dev-password-12345' });
  });

  it('skips the form entirely when a session already exists', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { user: { id: 'u1', email: 'a@b.c' }, authType: 'session', csrfToken: 'tok' } }));
    setup();
    await waitFor(() => expect(screen.getByText('Signed-in home')).toBeInTheDocument());
  });
});

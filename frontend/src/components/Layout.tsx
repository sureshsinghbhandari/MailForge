import { useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/auth';
import { EventsProvider } from '../context/EventsProvider';
import { useEvents } from '../context/events';
import { SettingsProvider } from '../context/SettingsProvider';
import { AtIcon, CogIcon, HomeIcon, InboxIcon, KeyIcon, LogoutIcon, MenuIcon, PulseIcon, CloseIcon } from './icons';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', Icon: HomeIcon, end: true },
  { to: '/mailboxes', label: 'Mailboxes', Icon: AtIcon },
  { to: '/messages', label: 'Messages', Icon: InboxIcon },
  { to: '/api-keys', label: 'API Keys', Icon: KeyIcon },
  { to: '/settings', label: 'Settings', Icon: CogIcon },
  { to: '/status', label: 'System Status', Icon: PulseIcon },
];

function LiveIndicator() {
  const { status } = useEvents();
  const live = status === 'live';
  return (
    <span
      data-testid="live-indicator"
      className={`badge ${live ? 'badge-green' : status === 'connecting' ? 'badge-gray' : 'badge-amber'}`}
      title={live ? 'Receiving real-time updates' : 'Real-time updates are not connected'}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-500 live-dot-reconnecting'}`}
      />
      {live ? 'Live' : status === 'connecting' ? 'Connecting' : 'Reconnecting'}
    </span>
  );
}

function Shell() {
  const { state, logout } = useAuth();
  const { unread } = useEvents();
  const [menuOpen, setMenuOpen] = useState(false);
  const email = state.status === 'authenticated' ? state.user.email : null;

  return (
    <div className="min-h-screen md:flex">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-white px-3 py-2 text-sm text-slate-900 focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <aside className="border-b border-slate-200 bg-white md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-600 text-white">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7l9 6 9-6M3 7v10h18V7z" />
              </svg>
            </span>
            <span className="truncate text-base font-semibold tracking-tight">MailForge</span>
          </div>
          <div className="flex items-center gap-2">
            <LiveIndicator />
            <button
              type="button"
              className="icon-btn md:hidden"
              aria-expanded={menuOpen}
              aria-controls="main-nav"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
              <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
            </button>
          </div>
        </div>
        <nav
          id="main-nav"
          aria-label="Main"
          className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-1 px-3 pb-3 md:flex md:pb-4`}
        >
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end ?? false}
              onClick={() => setMenuOpen(false)}
              aria-describedby={to === '/messages' && unread ? 'unread-desc' : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`
              }
            >
              <Icon />
              <span className="flex-1">{label}</span>
              {to === '/messages' && unread ? (
                <span aria-hidden="true" data-testid="unread-badge" className="badge bg-indigo-600 text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </NavLink>
          ))}
          {unread ? (
            <span id="unread-desc" className="sr-only">
              {unread} unread
            </span>
          ) : null}
          <div className="mt-2 border-t border-slate-200 pt-3 dark:border-slate-800 md:mt-4">
            {email ? (
              <p className="mb-2 truncate px-3 text-xs text-slate-500 dark:text-slate-400" title={email}>
                {email}
              </p>
            ) : null}
            <button type="button" className="btn w-full justify-start" onClick={() => void logout()}>
              <LogoutIcon />
              Sign out
            </button>
          </div>
        </nav>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Authenticated shell: owns the single SSE connection and the settings cache. */
export function Layout() {
  return (
    <SettingsProvider>
      <EventsProvider>
        <Shell />
      </EventsProvider>
    </SettingsProvider>
  );
}

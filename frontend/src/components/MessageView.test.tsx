import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '../lib/types';
import { MessageView } from './MessageView';

function makeMessage(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: 'msg-1',
    mailboxId: 'mb-1',
    mailboxEmail: 'box-abc123@mailtest.local',
    messageId: '<1@example.com>',
    fromAddress: 'sender@example.com',
    fromName: 'Sender',
    to: 'box-abc123@mailtest.local',
    subject: 'Hello',
    preview: 'preview',
    receivedAt: '2026-01-01T12:00:00.000Z',
    isRead: false,
    size: 1234,
    attachmentCount: 0,
    linkCount: 0,
    codeCount: 0,
    cc: null,
    bcc: null,
    replyTo: null,
    text: 'plain text body',
    html: '<p>sanitised</p>',
    headers: [
      { name: 'From', value: 'Sender <sender@example.com>' },
      { name: 'Received', value: 'from a by b' },
      { name: 'Received', value: 'from c by d' },
    ],
    attachments: [],
    codes: [],
    links: [],
    verificationCode: null,
    verificationUrl: null,
    ...overrides,
  };
}

function renderView(message: MessageDetail, handlers: Partial<Parameters<typeof MessageView>[0]> = {}) {
  return render(
    <MemoryRouter>
      <MessageView message={message} onBack={vi.fn()} onDelete={vi.fn()} onToggleRead={vi.fn()} {...handlers} />
    </MemoryRouter>,
  );
}

describe('MessageView', () => {
  it('renders HTML only in a script-less, origin-less sandboxed iframe loaded from the server (no srcdoc)', () => {
    renderView(makeMessage());
    const frame = screen.getByTitle('Email HTML');
    expect(frame.tagName).toBe('IFRAME');
    const tokens = (frame.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
    expect(tokens.sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-same-origin');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toBe('/api/messages/msg-1/html');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // the sanitised fragment is never injected into the app's own DOM
    expect(document.body.textContent).not.toContain('sanitised');
  });

  it('toggles remote images by changing only the iframe src', async () => {
    const user = userEvent.setup();
    renderView(makeMessage());
    expect(screen.getByText(/Remote images blocked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load remote images' }));
    expect(screen.getByTitle('Email HTML').getAttribute('src')).toBe('/api/messages/msg-1/html?images=true');
    expect(screen.getByTitle('Email HTML').getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('defaults to the Text tab (no iframe) when the message has no HTML part', () => {
    renderView(makeMessage({ html: null }));
    expect(screen.queryByTitle('Email HTML')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Text', selected: true })).toBeInTheDocument();
    expect(screen.getByText('plain text body').tagName).toBe('PRE');
  });

  it('renders a hostile subject, sender, text and headers as plain text', async () => {
    const user = userEvent.setup();
    const hostile = '<img src=x onerror=alert(1)>';
    renderView(
      makeMessage({
        subject: hostile,
        fromName: hostile,
        text: `${hostile} <script>alert(2)</script>`,
        headers: [{ name: 'X-Evil', value: hostile }],
        html: null,
      }),
    );
    const subject = screen.getByTestId('message-subject');
    expect(subject.textContent).toBe(hostile);
    expect(subject.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Headers' }));
    expect(screen.getByRole('cell', { name: hostile })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('offers Open only for http(s) links, with safe rel attributes, and lists codes by confidence', () => {
    renderView(
      makeMessage({
        codes: [
          { code: '111111', codeType: 'otp', confidence: 0.3 },
          { code: '482913', codeType: 'otp', confidence: 0.95 },
        ],
        links: [
          { url: 'javascript:alert(1)', linkType: 'other', isVerification: false },
          { url: 'https://app.example.com/verify?token=abc', linkType: 'verify', isVerification: true },
          { url: 'mailto:someone@example.com', linkType: 'other', isVerification: false },
        ],
      }),
    );
    expect(screen.getAllByTestId('detected-code').map((e) => e.textContent)).toEqual(['482913', '111111']);

    const links = screen.getAllByTestId('detected-link');
    expect(links.map((e) => e.textContent)).toEqual([
      'https://app.example.com/verify?token=abc',
      'javascript:alert(1)',
      'mailto:someone@example.com',
    ]);
    const openLinks = screen.getAllByRole('link', { name: /^Open/ });
    expect(openLinks).toHaveLength(1);
    expect(openLinks[0]).toHaveAttribute('href', 'https://app.example.com/verify?token=abc');
    expect(openLinks[0]).toHaveAttribute('target', '_blank');
    expect(openLinks[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(screen.getByText('likely verification')).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('has an accessible tab list with keyboard navigation and an attachment count', async () => {
    const user = userEvent.setup();
    renderView(makeMessage({ attachments: [{ id: 'a1', filename: '<b>x</b>.pdf', mimeType: 'application/pdf', size: 2048, stored: true }] }));
    const tablist = screen.getByRole('tablist');
    expect(within(tablist).getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['HTML', 'Text', 'Headers', 'Raw', 'Attachments']);
    expect(screen.getByRole('tab', { name: 'Attachments' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    screen.getByRole('tab', { name: 'HTML' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Text' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('cell', { name: '<b>x</b>.pdf' })).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: /Download.*pdf/ })).toHaveAttribute('href', '/api/messages/msg-1/attachments/a1');
  });

  it('wires Back, Mark unread and Delete message buttons, and links the .eml download', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onDelete = vi.fn();
    const onToggleRead = vi.fn();
    renderView(makeMessage({ isRead: true }), { onBack, onDelete, onToggleRead });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Mark unread' }));
    await user.click(screen.getByRole('button', { name: 'Delete message' }));
    expect([onBack, onToggleRead, onDelete].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(screen.getByRole('link', { name: 'Download .eml' })).toHaveAttribute('href', '/api/messages/msg-1/raw?download=true');
  });
});

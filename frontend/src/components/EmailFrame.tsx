import { emailFrameUrl } from '../lib/api';

/** The only sandbox tokens ever granted to email content: no scripts, no same-origin access. */
export const EMAIL_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Renders the server-sanitised email document. The server serves it from /api/messages/:id/html with its own
 * strict CSP header (and CSP `sandbox`), so the page here only adds the iframe sandbox and never injects markup.
 */
export function EmailFrame({ messageId, allowRemoteImages }: { messageId: string; allowRemoteImages: boolean }) {
  return (
    <iframe
      title="Email HTML"
      sandbox={EMAIL_SANDBOX}
      referrerPolicy="no-referrer"
      src={emailFrameUrl(messageId, allowRemoteImages)}
      className="block h-[70vh] min-h-[480px] w-full resize-y overflow-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700"
    />
  );
}

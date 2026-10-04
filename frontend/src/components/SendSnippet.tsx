import type { PublicSettings } from '../lib/types';
import { buildSnippet } from '../lib/snippet';
import { CopyButton } from './CopyButton';

export function SendSnippet({ settings, to }: { settings: PublicSettings; to?: string | undefined }) {
  const address = to ?? `test-abc123@${settings.mailDomains[0] ?? 'mail.test'}`;
  const code = buildSnippet(settings, address);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Send a test email to <span className="font-mono">{address}</span> via SMTP{' '}
          <span className="font-mono">
            {settings.smtpHost}:{settings.smtpPort}
          </span>
          .
        </p>
        <CopyButton text={code} label="Copy snippet" />
      </div>
      <pre className="code-block" tabIndex={0} aria-label="Nodemailer example">
        <code>{code}</code>
      </pre>
    </div>
  );
}

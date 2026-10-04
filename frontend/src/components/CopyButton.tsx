import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import { CheckIcon, CopyIcon } from './icons';

export function CopyButton({
  text,
  label = 'Copy',
  ariaLabel,
  className = 'btn btn-sm',
  iconOnly = false,
  children,
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
  iconOnly?: boolean;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function onClick() {
    const ok = await copyText(text);
    setCopied(ok);
    setFailed(!ok);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1500);
  }

  const text_ = copied ? 'Copied!' : failed ? 'Copy failed' : label;
  return (
    <button type="button" className={className} onClick={() => void onClick()} aria-label={ariaLabel} title={ariaLabel ?? label}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {iconOnly ? <span className="sr-only">{text_}</span> : <span>{children && !copied && !failed ? children : text_}</span>}
    </button>
  );
}

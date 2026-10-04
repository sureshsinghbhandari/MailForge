import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

/**
 * Text input that commits its value to the parent after `delay` ms of inactivity.
 * It owns the draft text; to reset it from outside, change the `key` prop.
 */
export function DebouncedInput({
  value,
  onCommit,
  delay = 300,
  ...rest
}: {
  value: string;
  onCommit: (value: string) => void;
  delay?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'>) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit.current(next), delay);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          window.clearTimeout(timer.current);
          commit.current(draft);
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}

import { useState } from 'react';
import { useDesktop } from '../api';

export function Composer() {
  const status = useDesktop((s) => s.status);
  const session = useDesktop((s) => s.sessions.find((x) => x.id === s.selectedSessionId));
  const send = useDesktop((s) => s.send);
  const [value, setValue] = useState('');

  const locked = !!session && !session.keyAvailable;
  const disabled = status === 'offline' || !session || locked;

  const placeholder = !session
    ? 'Select a session to start typing'
    : locked
      ? 'Encrypted — no key available on this device'
      : status === 'offline'
        ? 'Offline — reconnect to send'
        : `Message ${session.title}…`;

  function submit() {
    const text = value;
    if (!text.trim() || disabled) return;
    setValue('');
    void send(text);
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/30 px-5 py-3">
      <div className="mx-auto flex max-w-[760px] items-end gap-2">
        <textarea
          value={value}
          disabled={disabled}
          data-testid="composer-input"
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          placeholder={placeholder}
          aria-label="Message composer"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-200 placeholder-zinc-600 outline-none transition-colors duration-150 focus:border-zinc-600 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

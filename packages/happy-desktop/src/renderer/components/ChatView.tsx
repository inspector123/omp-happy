import { useEffect, useRef } from 'react';
import { selectSelectedMessages, useDesktop } from '../api';
import { MessageView } from './MessageView';

function LockNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <svg width="22" height="22" viewBox="0 0 16 16" fill="none" aria-hidden className="text-zinc-600">
        <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="text-[13px] text-zinc-400">This session is end-to-end encrypted</div>
      <div className="max-w-[320px] text-[12px] text-zinc-600">
        No decryption key is available on this device. Messages will appear once a key is shared.
      </div>
    </div>
  );
}

export function ChatView() {
  const selectedSessionId = useDesktop((s) => s.selectedSessionId);
  const session = useDesktop((s) => s.sessions.find((x) => x.id === s.selectedSessionId));
  const messages = useDesktop(selectSelectedMessages);

  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // New session: re-pin to the bottom.
  useEffect(() => {
    pinnedRef.current = true;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedSessionId]);

  // Auto-scroll on new content unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (!selectedSessionId || !session) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-zinc-600">
        Select a session to view messages
      </div>
    );
  }

  if (!session.keyAvailable) {
    return (
      <div className="h-full p-6">
        <LockNotice />
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      data-testid="message-list"
      className="h-full overflow-y-auto px-5 py-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <div className="mx-auto flex max-w-[760px] flex-col gap-1.5">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {messages.length === 0 && <div className="py-8 text-center text-[12px] text-zinc-600">No messages yet</div>}
      </div>
    </div>
  );
}

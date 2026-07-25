import type { MessageView as MessageViewData } from '../api';

function ToolGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-zinc-500">
      <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5v-5Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8v5M3 5.5 8 8l5-2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function MessageView({ message }: { message: MessageViewData }) {
  const { role, kind, text } = message;

  if (kind === 'event') {
    return <div className="msg-enter py-1 text-center text-[11px] text-zinc-600">{text}</div>;
  }

  if (kind === 'tool') {
    return (
      <div className="msg-enter flex justify-start py-0.5">
        <span className="flex max-w-[75%] items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1 font-mono text-[11.5px] text-zinc-500">
          <ToolGlyph />
          <span className="truncate">{text}</span>
        </span>
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="msg-enter flex justify-end py-0.5">
        <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-blue-600 px-3.5 py-2 text-[13px] leading-relaxed text-white shadow-sm">
          {text}
        </div>
      </div>
    );
  }

  if (kind === 'thinking') {
    return (
      <div className="msg-enter flex justify-start py-0.5">
        <div className="max-w-[75%] whitespace-pre-wrap text-[13px] italic leading-relaxed text-zinc-500">{text}</div>
      </div>
    );
  }

  // agent / system text
  return (
    <div className="msg-enter flex justify-start py-0.5">
      <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2 text-[13px] leading-relaxed text-zinc-200">
        {text}
        {text === '' && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-zinc-600 align-middle" />}
      </div>
    </div>
  );
}

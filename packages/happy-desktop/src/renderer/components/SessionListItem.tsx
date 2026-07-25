import type { SessionView } from '../api';
import { formatRelativeTime, truncateMiddle } from '../api';

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-zinc-500">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SessionListItem(props: {
  session: SessionView;
  selected: boolean;
  unseen: boolean;
  errored: boolean;
  onSelect: (id: string) => void;
}) {
  const { session, selected, unseen, errored } = props;

  const dotClass = errored
    ? 'bg-red-500'
    : session.thinking
      ? 'bg-emerald-400 dot-pulse'
      : session.active
        ? 'bg-emerald-500'
        : 'bg-zinc-600';

  return (
    <button
      type="button"
      data-testid="session-item"
      data-session-id={session.id}
      onClick={() => props.onSelect(session.id)}
      className={[
        'group flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150',
        selected ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            selected ? 'text-zinc-100' : unseen ? 'text-zinc-200' : 'text-zinc-400'
          }`}
        >
          {session.title}
        </span>
        {unseen && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" aria-label="unseen activity" />}
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{formatRelativeTime(session.updatedAt)}</span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        {session.keyAvailable ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600" title={session.path}>
              {session.path ? truncateMiddle(session.path, 38) : '—'}
            </span>
            {session.agent && (
              <span className="shrink-0 rounded border border-zinc-700/80 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                {session.agent}
              </span>
            )}
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] italic text-zinc-600">
            <LockIcon />
            encrypted
          </span>
        )}
      </div>
    </button>
  );
}

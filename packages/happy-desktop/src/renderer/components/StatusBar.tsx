import { truncateMiddle, useDesktop } from '../api';

export function StatusBar() {
  const session = useDesktop((s) => s.sessions.find((x) => x.id === s.selectedSessionId));
  const status = useDesktop((s) => s.status);
  const stoppingSessionId = useDesktop((s) => s.stoppingSessionId);
  const stopSession = useDesktop((s) => s.stopSession);
  const stopping = !!session && stoppingSessionId === session.id;
  const stopDisabledReason = !session
    ? undefined
    : status !== 'online'
      ? 'Connect to Happy before stopping this session.'
      : !session.keyAvailable
        ? 'The session encryption key is unavailable.'
        : undefined;

  function requestStop(): void {
    if (!session || stopDisabledReason || stopping) return;
    const confirmed = window.confirm(
      `Stop "${session.title}"? This terminates the agent process on its machine.`,
    );
    if (confirmed) {
      void stopSession(session.id);
    }
  }

  return (
    <header className="flex h-[44px] shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/30 px-4">
      {session ? (
        <>
          <span className="min-w-0 truncate text-[13px] font-medium text-zinc-100">{session.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-zinc-500">
            {session.agent && (
              <span className="shrink-0 rounded border border-zinc-700/80 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                {session.agent}
              </span>
            )}
            {session.path && <span className="min-w-0 truncate">{truncateMiddle(session.path, 52)}</span>}
          </span>
          <span className="flex-1" />
          {session.thinking && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-zinc-400">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="spinner text-zinc-400">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10" strokeLinecap="round" />
              </svg>
              thinking
            </span>
          )}
          {session.active && (
            <button
              type="button"
              onClick={requestStop}
              disabled={!!stopDisabledReason || stopping}
              title={stopDisabledReason ?? 'Stop this session'}
              aria-label="Stop session"
              className="h-7 shrink-0 rounded-md border border-red-900/70 px-2.5 text-[11px] text-red-400 transition-colors hover:border-red-800 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </>
      ) : (
        <span className="text-[13px] text-zinc-600">{status === 'offline' ? 'Offline' : 'No session selected'}</span>
      )}
    </header>
  );
}

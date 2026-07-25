import { useDesktop } from '../api';
import { SessionListItem } from './SessionListItem';

const STATUS_PILL: Record<string, { dot: string; label: string; className: string }> = {
  online: { dot: 'bg-emerald-500', label: 'Connected', className: 'border-zinc-800 text-zinc-400' },
  connecting: { dot: 'bg-amber-400 dot-pulse', label: 'Connecting', className: 'border-zinc-800 text-zinc-400' },
  offline: { dot: 'bg-red-500', label: 'Offline', className: 'border-red-900/60 text-red-400' },
};

export function SessionList() {
  const sessions = useDesktop((s) => s.sessions);
  const status = useDesktop((s) => s.status);
  const error = useDesktop((s) => s.error);
  const selectedSessionId = useDesktop((s) => s.selectedSessionId);
  const unseen = useDesktop((s) => s.unseen);
  const selectSession = useDesktop((s) => s.selectSession);

  const pill = STATUS_PILL[status] ?? STATUS_PILL.connecting;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3.5">
        <span className="text-[13px] font-semibold tracking-tight text-zinc-100">Happy</span>
        <span
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${pill.className}`}
          title={error}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} aria-hidden />
          {pill.label}
        </span>
      </div>

      <div className="px-3.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">Sessions</div>

      <div className="flex-1 overflow-y-auto px-2 pb-2" role="listbox" aria-label="Sessions" data-testid="session-list">
        {sessions.map((s) => (
          <SessionListItem
            key={s.id}
            session={s}
            selected={s.id === selectedSessionId}
            unseen={!!unseen[s.id]}
            errored={!!error && s.id === selectedSessionId}
            onSelect={selectSession}
          />
        ))}
        {sessions.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-zinc-600">
            {status === 'offline' ? 'Offline — no sessions' : 'Loading sessions…'}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800/70 px-3.5 py-2 text-[11px] text-zinc-600">
        ⌘K switch · ⌘1–9 jump · ↑↓ navigate
      </div>
    </aside>
  );
}

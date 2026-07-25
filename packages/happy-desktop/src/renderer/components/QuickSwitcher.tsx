import { useEffect, useMemo, useRef, useState } from 'react';
import { filterSessions, truncateMiddle, useDesktop } from '../api';

export function QuickSwitcher() {
  const open = useDesktop((s) => s.switcherOpen);
  const sessions = useDesktop((s) => s.sessions);
  const unseen = useDesktop((s) => s.unseen);
  const selectSession = useDesktop((s) => s.selectSession);
  const toggleSwitcher = useDesktop((s) => s.toggleSwitcher);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => filterSessions(sessions, query).slice(0, 9), [sessions, query]);

  // Reset state every time the switcher opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  function choose(index: number) {
    const target = results[index];
    if (!target) return;
    selectSession(target.id);
    toggleSwitcher(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh]"
      onMouseDown={() => toggleSwitcher(false)}
    >
      <div
        className="w-[520px] overflow-hidden rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-800 px-3.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(activeIndex);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                toggleSwitcher(false);
              }
            }}
            placeholder="Switch to session…"
            aria-label="Switch to session"
            className="h-[44px] w-full bg-transparent text-[13.5px] text-zinc-100 placeholder-zinc-600 outline-none"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {results.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(i)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 ${
                i === activeIndex ? 'bg-zinc-800' : ''
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  s.thinking ? 'bg-emerald-400 dot-pulse' : s.active ? 'bg-emerald-500' : 'bg-zinc-600'
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-zinc-200">{s.title}</span>
                <span className="block truncate text-[11px] text-zinc-600">
                  {s.keyAvailable ? (s.path ? truncateMiddle(s.path, 48) : '—') : 'encrypted'}
                </span>
              </span>
              {unseen[s.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" aria-hidden />}
              {s.agent && (
                <span className="shrink-0 rounded border border-zinc-700/80 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                  {s.agent}
                </span>
              )}
              {i < 9 && <span className="shrink-0 text-[10px] text-zinc-700">⌘{i + 1}</span>}
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-zinc-600">No matching sessions</div>}
        </div>
      </div>
    </div>
  );
}

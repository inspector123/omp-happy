import { useMemo, useState, type SyntheticEvent } from 'react';
import {
  SPAWN_SESSION_AGENTS,
  useDesktop,
  type SpawnSessionAgent,
} from '../api';

interface MachineOption {
  id: string;
  directory: string;
}

export function NewSessionControl() {
  const sessions = useDesktop((state) => state.sessions);
  const selectedSessionId = useDesktop((state) => state.selectedSessionId);
  const status = useDesktop((state) => state.status);
  const spawning = useDesktop((state) => state.spawning);
  const spawnSession = useDesktop((state) => state.spawnSession);
  const clearError = useDesktop((state) => state.clearError);

  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [directory, setDirectory] = useState('');
  const [agent, setAgent] = useState<SpawnSessionAgent>('omp');

  const machineOptions = useMemo(() => {
    const byId = new Map<string, MachineOption>();
    for (const session of sessions) {
      if (!session.machineId) continue;
      const existing = byId.get(session.machineId);
      if (!existing) {
        byId.set(session.machineId, { id: session.machineId, directory: session.path ?? '' });
      } else if (!existing.directory && session.path) {
        existing.directory = session.path;
      }
    }
    return [...byId.values()];
  }, [sessions]);
  const machineAvailable = machineOptions.some((option) => option.id === machineId);

  const disabledReason = status !== 'online'
    ? 'Connect to Happy before starting a session.'
    : machineOptions.length === 0
      ? 'No machine metadata is available from synced sessions.'
      : undefined;

  function showForm(): void {
    if (disabledReason) return;
    const selected = sessions.find((session) => session.id === selectedSessionId && session.machineId);
    const fallback = machineOptions[0];
    const initialMachineId = selected?.machineId ?? fallback?.id ?? '';
    const initialDirectory = selected?.path
      ?? machineOptions.find((option) => option.id === initialMachineId)?.directory
      ?? '';
    setMachineId(initialMachineId);
    setDirectory(initialDirectory);
    setAgent('omp');
    clearError();
    setOpen(true);
  }

  function changeMachine(nextMachineId: string): void {
    setMachineId(nextMachineId);
    setDirectory(machineOptions.find((option) => option.id === nextMachineId)?.directory ?? '');
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = await spawnSession({ machineId, directory: directory.trim(), agent });
    if (result.type === 'success') {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={showForm}
        disabled={!!disabledReason || spawning}
        title={disabledReason ?? 'Start a new session'}
        aria-label="Start a new session"
        className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-700 text-[17px] leading-none text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>

      {open && (
        <form
          onSubmit={(event) => void submit(event)}
          className="absolute right-0 top-8 z-30 w-[260px] rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-2xl shadow-black/50"
          aria-label="New session"
        >
          <div className="mb-2.5 text-[12px] font-semibold text-zinc-200">New session</div>

          <label className="mb-2 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Machine
            <select
              value={machineId}
              onChange={(event) => changeMachine(event.target.value)}
              disabled={spawning}
              className="mt-1 block h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[12px] normal-case tracking-normal text-zinc-200 outline-none focus:border-blue-500"
            >
              {machineOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.id}</option>
              ))}
            </select>
          </label>

          <label className="mb-2 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Directory
            <input
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              disabled={spawning}
              placeholder="Project directory"
              autoFocus
              className="mt-1 block h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[12px] normal-case tracking-normal text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-blue-500"
            />
          </label>

          <label className="mb-3 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Agent
            <select
              value={agent}
              onChange={(event) => setAgent(event.target.value as SpawnSessionAgent)}
              disabled={spawning}
              className="mt-1 block h-8 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[12px] normal-case tracking-normal text-zinc-200 outline-none focus:border-blue-500"
            >
              {SPAWN_SESSION_AGENTS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={spawning}
              className="h-7 rounded-md px-2.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={spawning || !machineAvailable || !directory.trim()}
              className="h-7 rounded-md bg-blue-600 px-3 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {spawning ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

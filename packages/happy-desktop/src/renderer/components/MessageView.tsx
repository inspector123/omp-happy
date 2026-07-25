import { useState, useMemo, useCallback } from 'react';
import type { MessageView as MessageViewData } from '../api';

/* ------------------------------------------------------------------ */
/* Helpers: delegate_task structured rendering                         */
/* ------------------------------------------------------------------ */

type AgentRow = {
  id: string;
  description?: string;
  role?: string;
  sessionSubagent?: string;
  status?: string;
  toolCount?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  output?: string;
};
type ToolData = NonNullable<MessageViewData['toolData']>;


function normalizeStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') return undefined;
  switch (status.toLowerCase()) {
    case 'success':
    case 'succeeded':
    case 'done':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'aborted';
    default:
      return status.toLowerCase();
  }
}

function mergeAgents(
  input: unknown,
  result: unknown,
  isParentRunning: boolean,
  lifecycleStatuses: Map<string, string>,
): AgentRow[] {
  const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const tasks = Array.isArray(inputRecord.tasks) ? inputRecord.tasks : [];
  const rows: AgentRow[] = tasks.map((task, index) => {
    const item = task && typeof task === 'object' ? task as Record<string, unknown> : {};
    return {
      id: typeof item.id === 'string' && item.id.length > 0 ? item.id : `task-${index + 1}`,
      description: typeof item.description === 'string' ? item.description : undefined,
      role: typeof item.role === 'string'
        ? item.role
        : typeof item.agent === 'string'
          ? item.agent
          : undefined,
      sessionSubagent: typeof item.sessionSubagent === 'string' ? item.sessionSubagent : undefined,
      status: isParentRunning ? 'running' : undefined,
    };
  });
  const rowById = new Map(rows.map((row, index) => [row.id, index]));

  const upsert = (source: Record<string, unknown>, patch: Partial<AgentRow>) => {
    const sourceIndex = typeof source.index === 'number' && Number.isInteger(source.index)
      ? source.index
      : undefined;
    const sourceId = typeof source.id === 'string' ? source.id : undefined;
    let rowIndex = sourceIndex !== undefined && sourceIndex >= 0 && sourceIndex < rows.length
      ? sourceIndex
      : sourceId !== undefined
        ? rowById.get(sourceId)
        : undefined;

    if (rowIndex === undefined) {
      rowIndex = rows.length;
      const id = sourceId ?? `task-${rowIndex + 1}`;
      rows.push({ id });
      rowById.set(id, rowIndex);
    }

    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<AgentRow>;
    const previousId = rows[rowIndex].id;
    rows[rowIndex] = { ...rows[rowIndex], ...definedPatch };
    if (definedPatch.id && definedPatch.id !== previousId) {
      rowById.delete(previousId);
      rowById.set(definedPatch.id, rowIndex);
    }
  };

  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const details = resultRecord.details && typeof resultRecord.details === 'object'
    ? resultRecord.details as Record<string, unknown>
    : {};
  const progress = Array.isArray(details.progress) ? details.progress : [];
  const finalResults = Array.isArray(details.results) ? details.results : [];

  for (const value of progress) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    upsert(item, {
      id: typeof item.id === 'string' ? item.id : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
      status: normalizeStatus(item.status),
      toolCount: typeof item.toolCount === 'number' ? item.toolCount : undefined,
      tokens: typeof item.tokens === 'number' ? item.tokens : undefined,
      cost: typeof item.cost === 'number' ? item.cost : undefined,
    });
  }

  for (const value of finalResults) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const status = item.aborted
      ? 'aborted'
      : normalizeStatus(item.status)
        ?? (typeof item.exitCode === 'number' ? (item.exitCode === 0 ? 'completed' : 'failed') : 'completed');
    upsert(item, {
      id: typeof item.id === 'string' ? item.id : undefined,
      status,
      durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
      tokens: typeof item.tokens === 'number' ? item.tokens : undefined,
      output: typeof item.output === 'string' ? item.output : undefined,
    });
  }

  for (const row of rows) {
    if (!row.sessionSubagent) continue;
    const lifecycleStatus = lifecycleStatuses.get(row.sessionSubagent);
    if (lifecycleStatus) row.status = lifecycleStatus;
  }
  return rows;
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#3fb950',
  running: '#d29922',
  pending: '#d29922',
  queued: '#d29922',
  failed: '#f85149',
  aborted: '#6e7681',
};


function metricsLine(a: AgentRow): string | null {
  const parts: string[] = [];
  if (typeof a.toolCount === 'number') parts.push(`${a.toolCount} tools`);
  if (typeof a.tokens === 'number') parts.push(`${a.tokens.toLocaleString()} tok`);
  if (typeof a.cost === 'number') parts.push(`$${a.cost.toFixed(3)}`);
  if (typeof a.durationMs === 'number') parts.push(`${(a.durationMs / 1000).toFixed(1)}s`);
  return parts.length ? parts.join(' \u00B7 ') : null;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`shrink-0 text-zinc-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Render a single child timeline entry (text, thinking, or tool). */
function ChildEntryView({ entry, depth }: { entry: MessageViewData; depth: number }) {
  const indent = Math.min(depth, 4) * 12;

  if (entry.kind === 'event') return null;

  if (entry.kind === 'tool') {
    const isError = entry.toolData?.error === true;
    const hasResult = entry.toolData?.result !== undefined;
    return (
      <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: `${indent}px` }}>
        <ToolGlyph />
        <span className="truncate font-mono text-[11px] text-zinc-400">{entry.text}</span>
        {hasResult ? (
          <span className="font-mono text-[10px]" style={{ color: isError ? '#f85149' : '#3fb950' }}>
            {isError ? '✕' : '✓'}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-amber-500/70">running</span>
        )}
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <div className="py-0.5" style={{ paddingLeft: `${indent}px` }}>
        <span className="text-[10px] uppercase tracking-wide text-zinc-600">Reasoning</span>
        <div className="line-clamp-3 text-[11px] italic text-zinc-500/80">{entry.text}</div>
      </div>
    );
  }

  return (
    <div className="py-0.5" style={{ paddingLeft: `${indent}px` }}>
      <div className="line-clamp-3 whitespace-pre-wrap text-[11px] text-zinc-400">{entry.text}</div>
    </div>
  );
}

/** Recursive child timeline: renders nested child messages under an agent row. */
const MAX_VISIBLE_CHILD_ENTRIES = 12;

function ChildTimelineView({
  childIds,
  messageById,
  depth = 0,
}: {
  childIds: string[];
  messageById: Map<string, MessageViewData>;
  depth?: number;
}) {
  const entries = useMemo(
    () => childIds
      .map((id) => messageById.get(id))
      .filter((entry): entry is MessageViewData => entry !== undefined && entry.kind !== 'event'),
    [childIds, messageById],
  );
  const visibleEntries = entries.slice(-MAX_VISIBLE_CHILD_ENTRIES);
  const hiddenCount = entries.length - visibleEntries.length;

  if (entries.length === 0) return null;

  return (
    <div className="mt-1 border-l border-zinc-800/50 py-0.5">
      {hiddenCount > 0 && (
        <div className="px-2 py-0.5 text-[10px] italic text-zinc-600">
          {hiddenCount} earlier events hidden
        </div>
      )}
      {visibleEntries.map((entry) => {
        if (entry.kind === 'tool' && entry.toolData?.name === 'delegate_task') {
          return (
            <DelegateTaskCard
              key={entry.id}
              toolData={entry.toolData}
              messageById={messageById}
              nested
              depth={depth + 1}
            />
          );
        }
        return <ChildEntryView key={entry.id} entry={entry} depth={depth} />;
      })}
    </div>
  );
}

function AgentRowView({
  agent,
  childMessageIds,
  messageById,
}: {
  agent: AgentRow;
  childMessageIds?: string[];
  messageById: Map<string, MessageViewData>;
}) {
  const metrics = useMemo(() => metricsLine(agent), [agent]);
  const output = agent.output;
  const truncatedOutput = output && output.length > 2000 ? `${output.slice(0, 2000)}…` : output;
  const hasChildren = childMessageIds !== undefined && childMessageIds.length > 0;
  const [childExpanded, setChildExpanded] = useState(
    hasChildren && (agent.status === 'running' || agent.status === 'pending'),
  );

  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: STATUS_COLORS[agent.status ?? ''] ?? '#6e7681' }}
          aria-label={`status: ${agent.status ?? 'unknown'}`}
        />
        <span className="font-mono text-[11.5px] text-zinc-400">{agent.id}</span>
        {agent.status && <span className="font-mono text-[11px] text-zinc-500">{agent.status}</span>}
        {hasChildren && (
          <button
            type="button"
            onClick={() => setChildExpanded((value) => !value)}
            className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-400"
            aria-expanded={childExpanded}
          >
            <ChevronIcon open={childExpanded} />
            <span>{childMessageIds.length} event{childMessageIds.length === 1 ? '' : 's'}</span>
          </button>
        )}
      </div>
      {agent.description && <div className="mt-0.5 text-[11.5px] text-zinc-400">{agent.description}</div>}
      {agent.role && <div className="mt-0.5 text-[11px] italic text-zinc-500">{agent.role}</div>}
      {metrics && <div className="mt-0.5 text-[11px] text-zinc-500">{metrics}</div>}
      {truncatedOutput && (
        <pre className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded border border-zinc-800/40 bg-zinc-950/50 font-mono text-[11px] leading-relaxed text-zinc-400">
          <code>{truncatedOutput}</code>
        </pre>
      )}
      {hasChildren && childExpanded && (
        <ChildTimelineView childIds={childMessageIds} messageById={messageById} />
      )}
    </div>
  );
}

function DelegateTaskCard({
  toolData,
  messageById,
  nested = false,
  depth = 0,
}: {
  toolData: ToolData;
  messageById: Map<string, MessageViewData>;
  nested?: boolean;
  depth?: number;
}) {
  const isParentRunning = toolData.result === undefined && toolData.error !== true;
  const { childIdsBySubagent, lifecycleStatuses } = useMemo(() => {
    const ids = new Map<string, string[]>();
    const statuses = new Map<string, string>();
    for (const childId of toolData.childMessageIds ?? []) {
      const child = messageById.get(childId);
      if (!child?.subagentId) continue;

      if (child.kind === 'event' && child.toolData?.name === '__lifecycle__') {
        const input = child.toolData.input;
        const rawStatus = input && typeof input === 'object'
          ? (input as Record<string, unknown>).status
          : undefined;
        const status = normalizeStatus(rawStatus);
        if (status) {
          const previous = statuses.get(child.subagentId);
          const previousIsFailure = previous === 'failed' || previous === 'aborted';
          if (!(previousIsFailure && status === 'completed')) {
            statuses.set(child.subagentId, status);
          }
        }
        continue;
      }

      const bucket = ids.get(child.subagentId) ?? [];
      bucket.push(child.id);
      ids.set(child.subagentId, bucket);
    }
    return { childIdsBySubagent: ids, lifecycleStatuses: statuses };
  }, [messageById, toolData.childMessageIds]);

  const agents = useMemo(
    () => mergeAgents(toolData.input, toolData.result, isParentRunning, lifecycleStatuses),
    [isParentRunning, lifecycleStatuses, toolData.input, toolData.result],
  );
  const [expanded, setExpanded] = useState(isParentRunning);
  const toggle = useCallback(() => setExpanded((value) => !value), []);

  if (agents.length === 0) return null;

  const runningCount = agents.filter((agent) => agent.status === 'running' || agent.status === 'pending').length;
  const doneCount = agents.filter(
    (agent) => agent.status === 'completed' || agent.status === 'failed' || agent.status === 'aborted',
  ).length;
  const card = (
    <>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1.5 text-left font-mono text-[11.5px] text-zinc-400 hover:border-zinc-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        aria-expanded={expanded}
      >
        <ChevronIcon open={expanded} />
        <span className="shrink-0 text-zinc-500">delegate_task</span>
        <span className="truncate">{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
        {runningCount > 0 ? (
          <span className="ml-auto font-sans text-[11px] text-amber-500/80">{runningCount} running</span>
        ) : (
          <span className="ml-auto font-sans text-[11px] text-zinc-500">{doneCount}/{agents.length}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col gap-1.5 pl-1">
          {agents.map((agent) => (
            <AgentRowView
              key={agent.sessionSubagent ?? agent.id}
              agent={agent}
              childMessageIds={agent.sessionSubagent ? childIdsBySubagent.get(agent.sessionSubagent) : undefined}
              messageById={messageById}
            />
          ))}
        </div>
      )}
    </>
  );

  if (nested) {
    return (
      <div className="my-1" style={{ marginLeft: `${Math.min(depth, 4) * 12}px` }}>
        {card}
      </div>
    );
  }
  return (
    <div className="msg-enter flex justify-start py-0.5">
      <div className="w-full max-w-[75%]">{card}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

function ToolGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-zinc-500">
      <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5v-5Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8v5M3 5.5 8 8l5-2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function MessageView({ message, allMessages }: { message: MessageViewData; allMessages: MessageViewData[] }) {
  const { role, kind, text, toolData } = message;
  const messageById = useMemo(
    () => new Map(allMessages.map((entry) => [entry.id, entry])),
    [allMessages],
  );

  if (kind === 'event') {
    return <div className="msg-enter py-1 text-center text-[11px] text-zinc-600">{text}</div>;
  }

  if (kind === 'tool') {
    if (toolData?.name === 'delegate_task') {
      return <DelegateTaskCard toolData={toolData} messageById={messageById} />;
    }
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
        <div className="max-w-[75%]">
          <div className="text-[10px] uppercase tracking-wide text-zinc-600">Reasoning</div>
          <div className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-zinc-500">{text}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-enter flex justify-start py-0.5">
      <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-zinc-900 px-3.5 py-2 text-[13px] leading-relaxed text-zinc-200">
        {text}
        {text === '' && <span className="inline-block h-3.5 w-1.5 animate-pulse bg-zinc-600 align-middle" />}
      </div>
    </div>
  );
}

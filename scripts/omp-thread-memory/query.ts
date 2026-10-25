import type { Database, SQLQueryBindings } from "bun:sqlite";
import { homedir } from "node:os";
import type { SessionRow, TurnRow } from "./db.ts";

export type SearchField = "all" | "user" | "assistant" | "tools";

export interface SearchOptions {
	/** Keywords, quoted phrases, or FTS5 syntax (OR, NOT, prefix*). */
	query?: string;
	/** JavaScript regular expression applied line by line to the indexed turn text. */
	regex?: string;
	caseSensitive?: boolean;
	field?: SearchField;
	/** Substring of the session working directory. */
	cwd?: string;
	/** 30m, 12h, 7d, 2w, or a date. */
	since?: string;
	subagents?: boolean;
	limit?: number;
	/** Leaves out one session, normally the one doing the searching. */
	excludeId?: string;
	/** Wall-clock budget for a regex scan; the result notes when it stopped early. */
	budgetMs?: number;
}

export interface TurnHit {
	seq: number;
	at: number;
	text: string;
}

export interface ThreadHit {
	session: SessionRow;
	matches: number;
	hits: TurnHit[];
}

export interface SearchResult {
	threads: ThreadHit[];
	notes: string[];
}

export interface DeepHit {
	session: SessionRow;
	/** Matches (ripgrep) or matching lines (grep) in the raw session file. */
	matches: number;
	excerpt: string;
}

interface Scope {
	sql: string;
	params: SQLQueryBindings[];
}

interface Aggregate {
	best: number;
	matches: number;
	last: number;
	hits: TurnHit[];
}

const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };
const TURN_COLUMNS: Record<SearchField, string[]> = {
	all: ["user_text", "reply", "narration", "tools"],
	user: ["user_text"],
	assistant: ["reply", "narration"],
	tools: ["tools"],
};
const COLUMN_LABEL: Record<string, string> = { user_text: "user", reply: "reply", narration: "assistant", tools: "tools" };
/** A quantified group that itself contains a quantifier, the shape behind catastrophic backtracking. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})\)(?:[+*]|\{\d+(?:,\d*)?\})/;
const FTS_SYNTAX = /["*():^]|\b(?:AND|OR|NOT|NEAR)\b/;

export function tildify(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function formatTime(ms: number): string {
	return ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown time";
}

export function formatAge(ms: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - ms) / 60_000));
	if (minutes < 2) return "just now";
	if (minutes < 120) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
	if (minutes < 21 * 24 * 60) return `${Math.round(minutes / 1440)}d ago`;
	return `${Math.round(minutes / 10_080)}w ago`;
}

export function parseSince(since: string, now: number): number {
	const relativeSpan = /^(\d+)\s*([mhdw])$/i.exec(since.trim());
	if (relativeSpan?.[1] && relativeSpan[2]) {
		return now - Number(relativeSpan[1]) * (UNIT_MS[relativeSpan[2].toLowerCase()] ?? DAY);
	}
	const at = Date.parse(since);
	if (Number.isNaN(at)) throw new Error(`Unrecognized since value "${since}". Use 30m, 12h, 7d, 2w, or a date like 2026-10-01.`);
	return at;
}

export function compileRegex(source: string, caseSensitive = false): RegExp {
	if (NESTED_QUANTIFIER.test(source)) {
		throw new Error("The regex repeats a group that already contains a repeat, such as (a+)+, which can run for exponential time. Simplify it.");
	}
	try {
		return new RegExp(source, caseSensitive ? "" : "i");
	} catch (error) {
		throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function scopeOf(options: Pick<SearchOptions, "subagents" | "cwd" | "excludeId">): Scope {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (!options.subagents) clauses.push("s.agent = ''");
	if (options.excludeId) {
		clauses.push("s.id <> ?");
		params.push(options.excludeId);
	}
	if (options.cwd) {
		clauses.push("instr(s.cwd, ?) > 0");
		params.push(options.cwd);
	}
	return { sql: clauses.map(clause => ` AND ${clause}`).join(""), params };
}

function sessionsBySid(db: Database, sids: number[]): Map<number, SessionRow> {
	const rows = new Map<number, SessionRow>();
	for (let i = 0; i < sids.length; i += 500) {
		const batch = sids.slice(i, i + 500);
		const sql = `SELECT * FROM sessions WHERE sid IN (${batch.map(() => "?").join(",")})`;
		for (const row of db.query<SessionRow, number[]>(sql).all(...batch)) rows.set(row.sid, row);
	}
	return rows;
}

/** Plain-text FTS candidates, from the user's own syntax to an all-terms match to an any-term match. */
function ftsCandidates(query: string): string[] {
	const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(term => `"${term}"`);
	const candidates: string[] = [];
	if (FTS_SYNTAX.test(query)) candidates.push(query);
	if (terms.length > 0) candidates.push(terms.join(" "));
	if (terms.length > 1) candidates.push(terms.join(" OR "));
	return candidates;
}

function keywordSearch(db: Database, options: SearchOptions, query: string, since: number, now: number): ThreadHit[] {
	const scope = scopeOf(options);
	const field = options.field ?? "all";
	const columns = field === "all" ? "" : `{${TURN_COLUMNS[field].join(" ")}} : `;
	const turnQuery = db.query<{ sid: number; seq: number; at: number; rank: number; snip: string }, SQLQueryBindings[]>(
		`SELECT t.session_sid AS sid, t.seq AS seq, t.started_at AS at,
			bm25(turns_fts, 2.0, 1.5, 0.8, 0.5) AS rank, snippet(turns_fts, -1, '«', '»', '…', 24) AS snip
		 FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid JOIN sessions s ON s.sid = t.session_sid
		 WHERE turns_fts MATCH ? AND t.started_at >= ?${scope.sql} ORDER BY rank LIMIT 500`,
	);
	const titleQuery = db.query<{ sid: number; rank: number; snip: string }, SQLQueryBindings[]>(
		`SELECT s.sid AS sid, bm25(sessions_fts, 3.0, 1.0) AS rank, snippet(sessions_fts, -1, '«', '»', '…', 24) AS snip
		 FROM sessions_fts JOIN sessions s ON s.sid = sessions_fts.rowid
		 WHERE sessions_fts MATCH ? AND s.updated_at >= ?${scope.sql} ORDER BY rank LIMIT 100`,
	);
	const bySid = new Map<number, Aggregate>();
	for (const candidate of ftsCandidates(query)) {
		try {
			for (const row of turnQuery.all(`${columns}(${candidate})`, since, ...scope.params)) {
				const entry = bySid.get(row.sid) ?? { best: 0, matches: 0, last: 0, hits: [] };
				entry.best = Math.min(entry.best, row.rank);
				entry.matches++;
				entry.last = Math.max(entry.last, row.at);
				if (entry.hits.length < 3) entry.hits.push({ seq: row.seq, at: row.at, text: row.snip });
				bySid.set(row.sid, entry);
			}
			if (field === "all") {
				for (const row of titleQuery.all(candidate, since, ...scope.params)) {
					const entry = bySid.get(row.sid) ?? { best: 0, matches: 0, last: 0, hits: [] };
					entry.best += row.rank;
					entry.hits.unshift({ seq: 0, at: 0, text: row.snip });
					bySid.set(row.sid, entry);
				}
			}
		} catch (error) {
			// The model or user wrote FTS syntax SQLite rejects; fall through to the quoted-term forms.
			if (error instanceof Error && /fts5|syntax error|no such column|unterminated/i.test(error.message)) continue;
			throw error;
		}
		// Respect a query the user wrote in FTS syntax; only plain all-terms searches widen to any-term.
		if (bySid.size > 0 || candidate === query) break;
	}
	const sessions = sessionsBySid(db, [...bySid.keys()]);
	const scored: { hit: ThreadHit; score: number }[] = [];
	for (const [sid, entry] of bySid) {
		const session = sessions.get(sid);
		if (!session) continue;
		// bm25 is negative (better is lower); older threads keep at least half their relevance.
		const relevance = -entry.best + 0.5 * Math.log1p(entry.matches);
		const recency = 0.5 + 0.5 * Math.exp(-(now - session.updated_at) / (21 * DAY));
		scored.push({ hit: { session, matches: entry.matches, hits: entry.hits.slice(0, 3) }, score: relevance * recency });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, options.limit ?? 10).map(entry => entry.hit);
}

function regexSearch(
	db: Database,
	options: SearchOptions,
	source: string,
	since: number,
	now: number,
	notes: string[],
): ThreadHit[] {
	const pattern = compileRegex(source, options.caseSensitive);
	const scope = scopeOf(options);
	const columns = TURN_COLUMNS[options.field ?? "all"];
	const deadline = now + (options.budgetMs ?? 8000);
	const bySid = new Map<number, Aggregate>();
	const record = (sid: number, seq: number, at: number, label: string, text: string): void => {
		let excerpt = "";
		let count = 0;
		for (const line of text.split("\n")) {
			const match = pattern.exec(line);
			if (!match) continue;
			count++;
			if (excerpt) continue;
			const start = Math.max(0, match.index - 90);
			const end = Math.min(line.length, match.index + match[0].length + 90);
			excerpt = `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
		}
		if (count === 0) return;
		const entry = bySid.get(sid) ?? { best: 0, matches: 0, last: 0, hits: [] };
		entry.matches += count;
		entry.last = Math.max(entry.last, at);
		if (entry.hits.length < 3) entry.hits.push({ seq, at, text: `${label}: ${excerpt}` });
		bySid.set(sid, entry);
	};
	const turns = db.query<Record<string, string | number>, SQLQueryBindings[]>(
		`SELECT t.session_sid AS sid, t.seq AS seq, t.started_at AS at, ${columns.map(column => `t.${column}`).join(", ")}
		 FROM turns t JOIN sessions s ON s.sid = t.session_sid
		 WHERE t.started_at >= ?${scope.sql} ORDER BY t.started_at DESC`,
	);
	let scanned = 0;
	for (const row of turns.iterate(since, ...scope.params)) {
		if (++scanned % 512 === 0 && Date.now() > deadline) {
			notes.push(`Regex scan stopped at its ${options.budgetMs ?? 8000} ms budget after the newest ${scanned} turns; narrow it with since or cwd.`);
			break;
		}
		for (const column of columns) {
			record(Number(row.sid), Number(row.seq), Number(row.at), COLUMN_LABEL[column] ?? column, String(row[column] ?? ""));
		}
	}
	if (options.field === undefined || options.field === "all") {
		const titles = db.query<{ sid: number; title: string; todo: string }, SQLQueryBindings[]>(
			`SELECT s.sid AS sid, s.title AS title, s.todo AS todo FROM sessions s WHERE s.updated_at >= ?${scope.sql}`,
		);
		for (const row of titles.iterate(since, ...scope.params)) {
			record(row.sid, 0, 0, "title", row.title);
			record(row.sid, 0, 0, "todo", row.todo);
		}
	}
	const sessions = sessionsBySid(db, [...bySid.keys()]);
	const hits: { hit: ThreadHit; last: number }[] = [];
	for (const [sid, entry] of bySid) {
		const session = sessions.get(sid);
		if (session) hits.push({ hit: { session, matches: entry.matches, hits: entry.hits }, last: entry.last || session.updated_at });
	}
	hits.sort((a, b) => b.last - a.last || b.hit.matches - a.hit.matches);
	return hits.slice(0, options.limit ?? 10).map(entry => entry.hit);
}

export function recentThreads(
	db: Database,
	options: { cwd?: string; limit?: number; subagents?: boolean; since?: number; excludeId?: string },
): SessionRow[] {
	const scope = scopeOf(options);
	return db
		.query<SessionRow, SQLQueryBindings[]>(
			`SELECT * FROM sessions s WHERE s.turn_count > 0 AND s.missing = 0 AND s.updated_at >= ?${scope.sql}
			 ORDER BY s.updated_at DESC LIMIT ?`,
		)
		.all(options.since ?? 0, ...scope.params, options.limit ?? 10);
}

/** Ranked keyword search, regex search, or (with neither) the most recently active threads. */
export function searchThreads(db: Database, options: SearchOptions, now = Date.now()): SearchResult {
	const since = options.since ? parseSince(options.since, now) : 0;
	const notes: string[] = [];
	if (options.regex) return { threads: regexSearch(db, options, options.regex, since, now, notes), notes };
	if (options.query?.trim()) return { threads: keywordSearch(db, options, options.query, since, now), notes };
	const threads = recentThreads(db, { ...options, since }).map(session => ({ session, matches: 0, hits: [] }));
	return { threads, notes };
}

/**
 * Regex over the raw session JSONL lines, including the tool output the index leaves out. Runs
 * ripgrep when installed, otherwise GNU grep -P, over the indexed files that pass the filters.
 */
export async function deepSearch(
	db: Database,
	pattern: string,
	options: SearchOptions & { timeoutMs?: number },
	now = Date.now(),
): Promise<DeepHit[]> {
	const rg = Bun.which("rg");
	const grep = Bun.which("grep");
	const base = rg ? [rg, "--no-messages", "--no-config", "--with-filename"] : grep ? [grep, "-s", "-H", "-P"] : undefined;
	if (!base) throw new Error("Deep search needs ripgrep (rg) or GNU grep on PATH.");
	if (!options.caseSensitive) base.push("-i");
	const timeoutMs = options.timeoutMs ?? 60_000;
	const run = async (args: string[], files: string[]): Promise<string> => {
		const proc = Bun.spawn([...base, ...args, "--", ...files], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (proc.signalCode) throw new Error(`Deep search timed out after ${timeoutMs} ms.`);
		if (code === 2 && !stdout) throw new Error(`${rg ? "ripgrep" : "grep"} rejected the search: ${stderr.trim()}`);
		return stdout;
	};
	const scope = scopeOf(options);
	const since = options.since ? parseSince(options.since, now) : 0;
	const candidates = db
		.query<SessionRow, SQLQueryBindings[]>(
			`SELECT * FROM sessions s WHERE s.missing = 0 AND s.updated_at >= ?${scope.sql} ORDER BY s.updated_at DESC`,
		)
		.all(since, ...scope.params);
	const byFile = new Map(candidates.map(session => [session.file, session]));
	const counted: DeepHit[] = [];
	for (let i = 0; i < candidates.length; i += 1000) {
		const files = candidates.slice(i, i + 1000).map(session => session.file);
		const output = await run(rg ? ["--count-matches", "-e", pattern] : ["-c", "-e", pattern], files);
		for (const line of output.split("\n")) {
			const colon = line.lastIndexOf(":");
			const session = byFile.get(line.slice(0, colon));
			const matches = Number(line.slice(colon + 1));
			if (session && matches > 0) counted.push({ session, matches, excerpt: "" });
		}
	}
	counted.sort((a, b) => b.session.updated_at - a.session.updated_at);
	const top = counted.slice(0, options.limit ?? 10);
	if (top.length === 0) return top;
	const context = await run(["-o", "-m", "1", "-e", `.{0,100}(?:${pattern}).{0,100}`], top.map(hit => hit.session.file));
	for (const line of context.split("\n")) {
		const hit = top.find(candidate => !candidate.excerpt && line.startsWith(`${candidate.session.file}:`));
		if (!hit) continue;
		const raw = line.slice(hit.session.file.length + 1);
		hit.excerpt = raw.replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
	}
	return top;
}

/** Resolves a full session id, an id prefix, or a session file path. Newest first. */
export function resolveThread(db: Database, ref: string): SessionRow[] {
	const needle = ref.trim();
	if (!needle) return [];
	return db
		.query<SessionRow, [string, string, string]>(
			`SELECT * FROM sessions WHERE id = ?1 OR file = ?2 OR (length(?3) >= 4 AND id LIKE ?3 || '%')
			 ORDER BY (id = ?1) DESC, agent = '' DESC, updated_at DESC LIMIT 20`,
		)
		.all(needle, needle, needle.toLowerCase());
}

export function describeThread(session: SessionRow, now: number): string {
	const parts = [
		session.id,
		`"${session.title || "(untitled)"}"`,
		tildify(session.cwd || "?"),
		`${formatAge(session.updated_at, now)} (${formatTime(session.updated_at)})`,
		`${session.turn_count} turns`,
	];
	if (session.agent) parts.push(`subagent ${session.agent} of ${session.root_id}`);
	if (session.missing) parts.push("session file no longer exists");
	return parts.join(" · ");
}

export function formatSearch(result: SearchResult, heading: string, now: number): string {
	const lines = [heading];
	if (result.threads.length === 0) lines.push("No matching threads.");
	for (const [index, thread] of result.threads.entries()) {
		lines.push(`${index + 1}. ${describeThread(thread.session, now)}${thread.matches ? ` · ${thread.matches} matches` : ""}`);
		for (const hit of thread.hits) {
			const where = hit.seq > 0 ? `turn ${hit.seq} (${formatTime(hit.at)})` : "thread";
			lines.push(`   - ${where}: ${hit.text.replace(/\s+/g, " ").slice(0, 320)}`);
		}
	}
	lines.push(...result.notes);
	return lines.join("\n");
}

export function formatDeep(hits: DeepHit[], heading: string, now: number): string {
	const lines = [heading];
	if (hits.length === 0) lines.push("No session file contains a match.");
	for (const [index, hit] of hits.entries()) {
		const label = describeThread(hit.session, now);
		lines.push(`${index + 1}. ${label} · ${hit.matches} raw matches`);
		if (hit.excerpt) lines.push(`   - ${hit.excerpt.slice(0, 320)}`);
	}
	return lines.join("\n");
}

function block(title: string, text: string, max: number): string {
	const body = text.trim();
	if (!body) return "";
	return `${title}:\n${body.length > max ? `${body.slice(0, max)}\n…(${body.length - max} more characters)` : body}\n`;
}

/** The pickup card: identity, open todo, prompt timeline, and the selected turns in full. */
export function formatThread(
	db: Database,
	session: SessionRow,
	options: { turns?: number; around?: number },
	now: number,
): string {
	const timeline = db
		.query<Pick<TurnRow, "seq" | "started_at" | "origin" | "user_text">, [number]>(
			"SELECT seq, started_at, origin, substr(user_text, 1, 400) AS user_text FROM turns WHERE session_sid = ? ORDER BY seq",
		)
		.all(session.sid);
	const count = Math.min(Math.max(Math.trunc(options.turns ?? 3), 1), 12);
	const last = timeline.at(-1)?.seq ?? 0;
	const first = options.around
		? Math.max(1, Math.trunc(options.around) - Math.floor((count - 1) / 2))
		: Math.max(1, last - count + 1);
	const detail = db
		.query<TurnRow, [number, number, number]>("SELECT * FROM turns WHERE session_sid = ? AND seq BETWEEN ? AND ? ORDER BY seq")
		.all(session.sid, first, first + count - 1);
	const resumeId = session.agent ? session.root_id : session.id;
	const lines = [
		`# ${session.title || "(untitled thread)"}`,
		`session ${session.id} · ${session.turn_count} turns · started ${formatTime(session.created_at)} · last active ${formatTime(session.updated_at)} (${formatAge(session.updated_at, now)})`,
		`cwd: ${tildify(session.cwd)}`,
		`file: ${tildify(session.file)}${session.missing ? " (no longer exists)" : ""}`,
		`resume: cd ${tildify(session.cwd) || "~"} && omp -r ${resumeId.slice(0, 8)}`,
	];
	if (session.agent) lines.push(`subagent "${session.agent}" of session ${session.root_id}`);
	if (session.parent) lines.push(`forked from ${session.parent}`);
	lines.push("");
	if (session.todo) lines.push(block("Todo", session.todo, 2000));
	const shown = timeline.slice(-40);
	if (shown.length > 0) {
		lines.push(`Prompts (${timeline.length > shown.length ? `last ${shown.length} of ${timeline.length}` : timeline.length}):`);
		for (const turn of shown) {
			const prompt = turn.user_text.replace(/\s+/g, " ").trim().slice(0, 160) || "(no prompt)";
			lines.push(`${turn.seq}. ${formatTime(turn.started_at)}${turn.origin === "auto" ? " [automated]" : ""} · ${prompt}`);
		}
		lines.push("");
	}
	for (const turn of detail) {
		lines.push(`## Turn ${turn.seq} · ${formatTime(turn.started_at)}${turn.model ? ` · ${turn.model}` : ""}`);
		lines.push(block(turn.origin === "auto" ? "Automated prompt" : "User", turn.user_text, 2500));
		lines.push(block(`Tools (${turn.tool_count} calls${turn.tool_count > 20 ? ", last 20 shown" : ""})`, turn.tools.split("\n").slice(-20).join("\n"), 4000));
		if (turn.narration) lines.push(block("Earlier assistant notes", turn.narration.slice(-1500), 1500));
		lines.push(block("Reply", turn.reply, 4000));
	}
	const files = (JSON.parse(session.files) as string[])
		.slice(-15)
		.map(file => (session.cwd && file.startsWith(`${session.cwd}/`) ? file.slice(session.cwd.length + 1) : tildify(file)));
	if (files.length > 0) lines.push(`Files edited (most recent last): ${files.join(", ")}`);
	return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
}

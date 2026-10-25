import type { Database, Statement } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { SessionRow, TurnRow } from "./db.ts";

/** Bytes parsed per transaction. Bounds both the write-lock hold time and event-loop stalls. */
const CHUNK_BYTES = 4 << 20;
/** Enough of a line to read its entry type, message role, and tool name without parsing it. */
const HEAD_SCAN = 768;
const HEADER_BYTES = 64 << 10;
const USER_HEAD = 6000;
const USER_TAIL = 1500;
const REPLY_MAX = 8000;
const NARRATION_MAX = 6000;
const TOOL_LINE_MAX = 220;
const TOOL_HEAD = 15;
const TOOL_TAIL = 45;
const TODO_MAX = 2000;
const FILES_MAX = 40;
const OMITTED_TOOLS = /^… \d+ more tool calls$/;
const EDIT_HEADER = /^\[([^\]\n]+?)#[0-9A-Za-z]{2,8}\]/gm;

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\bgh[opsur]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{40,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}/g,
	/\b\d{8,10}:AA[A-Za-z0-9_-]{33}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Shapes of the omp session JSONL records this indexer reads (see omp docs/session.md). */
interface RawBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface RawPhase {
	name?: string;
	tasks?: { content?: string; status?: string }[];
}

interface RawMessage {
	role?: string;
	content?: string | RawBlock[];
	attribution?: string;
	steering?: boolean;
	liveSteered?: boolean;
	model?: string;
	toolName?: string;
	details?: { phases?: RawPhase[] };
}

interface RawEntry {
	type?: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	title?: string;
	parentSession?: string;
	message?: RawMessage;
	customType?: string;
	data?: { phases?: RawPhase[] };
}

export type IndexRecord =
	| { kind: "header"; id: string; cwd: string; at: number; title: string; parent: string }
	| { kind: "title"; title: string }
	| { kind: "user"; at: number; text: string; origin: string; steer: boolean }
	| { kind: "assistant"; at: number; text: string; tools: string[]; files: string[]; model: string }
	| { kind: "todo"; text: string };

interface SessionHead {
	id: string;
	cwd: string;
	at: number;
	title: string;
	parent: string;
}

export interface FileSyncResult {
	bytes: number;
	turns: number;
	complete: boolean;
}

export interface SyncSummary {
	scanned: number;
	changed: number;
	synced: number;
	pending: number;
	bytes: number;
	turns: number;
	ms: number;
}

type FileIdentity = Pick<SessionRow, "sid" | "file" | "id" | "file_ino" | "file_size" | "file_mtime" | "missing">;

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("#")) return trimmed;
	}
	return "";
}

export function redact(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
	return out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[REDACTED]");
}

function contentText(content: RawMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function editTargets(args: Record<string, unknown>): string[] {
	const targets = new Set<string>();
	if (typeof args.path === "string") targets.add(args.path);
	if (typeof args.input === "string") {
		for (const match of args.input.matchAll(EDIT_HEADER)) if (match[1]) targets.add(match[1]);
	}
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			if (edit && typeof edit === "object" && "path" in edit && typeof edit.path === "string") targets.add(edit.path);
		}
	}
	return [...targets];
}

function taskSummary(args: Record<string, unknown>): string {
	if (!Array.isArray(args.tasks)) return "";
	const names: string[] = [];
	for (const task of args.tasks) {
		if (!task || typeof task !== "object") continue;
		const name = "name" in task ? str(task.name) : "";
		names.push(name || clip(firstLine("task" in task ? str(task.task) : ""), 80));
	}
	return names.join(", ");
}

/** One searchable line per tool call: tool name, the model's stated intent, and the key argument. */
export function digestToolCall(name: string, args: Record<string, unknown>): string {
	let detail: string;
	switch (name) {
		case "bash":
			detail = `$ ${firstLine(str(args.command))}`;
			break;
		case "read":
		case "write":
		case "glob":
			detail = str(args.path);
			break;
		case "edit":
			detail = editTargets(args).join(", ");
			break;
		case "ast_edit":
			detail = touchedFiles(name, args).join(", ");
			break;
		case "ast_grep":
			detail = str(args.path);
			break;
		case "grep":
			detail = `/${str(args.pattern)}/ ${str(args.path)}`;
			break;
		case "web_search":
			detail = `"${str(args.query)}"`;
			break;
		case "browser":
			detail = `${str(args.action)} ${str(args.url)}`;
			break;
		case "todo":
			detail = `${str(args.op)} ${str(args.task) || str(args.phase)}`;
			break;
		case "eval":
			detail = str(args.title) || firstLine(str(args.code));
			break;
		case "task":
			detail = taskSummary(args);
			break;
		default: {
			const first = Object.entries(args).find(([key, value]) => key !== "i" && typeof value === "string");
			detail = first ? firstLine(str(first[1])) : "";
		}
	}
	const text = [str(args.i), detail.trim()].filter(Boolean).join(" · ");
	return clip(`${name}: ${text}`.replace(/\s+/g, " ").trim(), TOOL_LINE_MAX);
}

function touchedFiles(name: string, args: Record<string, unknown>): string[] {
	let paths: string[];
	switch (name) {
		case "edit":
			paths = editTargets(args);
			break;
		case "write":
			paths = [str(args.path)];
			break;
		case "ast_edit":
			paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string") : [];
			break;
		default:
			return [];
	}
	return paths.filter(path => path && !path.includes("://"));
}

function todoRecord(phases: RawPhase[] | undefined): IndexRecord | undefined {
	if (!Array.isArray(phases)) return undefined;
	let done = 0;
	let total = 0;
	const open: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks ?? []) {
			total++;
			const status = task.status ?? "pending";
			if (status === "completed") done++;
			if (status !== "pending" && status !== "in_progress" && status !== "blocked") continue;
			open.push(`- [${status}] ${task.content ?? ""}${phase.name ? ` (${phase.name})` : ""}`);
		}
	}
	const text = total === 0 ? "" : [`${done}/${total} done`, ...open].join("\n");
	return { kind: "todo", text: clip(redact(text), TODO_MAX) };
}

function messageRecord(message: RawMessage, at: number): IndexRecord | undefined {
	switch (message.role) {
		case "user":
			return {
				kind: "user",
				at,
				text: redact(contentText(message.content).trim()),
				origin: message.attribution === "agent" ? "auto" : "user",
				steer: message.steering === true || message.liveSteered === true,
			};
		case "assistant": {
			const texts: string[] = [];
			const tools: string[] = [];
			const files: string[] = [];
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block.type === "text" && block.text) texts.push(block.text);
				if (block.type !== "toolCall" || !block.name) continue;
				const args = block.arguments ?? {};
				tools.push(redact(digestToolCall(block.name, args)));
				files.push(...touchedFiles(block.name, args));
			}
			return { kind: "assistant", at, text: redact(texts.join("\n\n").trim()), tools, files, model: str(message.model) };
		}
		case "toolResult":
			return message.toolName === "todo" ? todoRecord(message.details?.phases) : undefined;
		default:
			return undefined;
	}
}

export function recordFromEntry(entry: RawEntry): IndexRecord | undefined {
	const at = Date.parse(str(entry.timestamp)) || 0;
	switch (entry.type) {
		case "session":
			return {
				kind: "header",
				id: str(entry.id),
				cwd: str(entry.cwd),
				at,
				title: str(entry.title),
				parent: str(entry.parentSession),
			};
		case "title":
		case "title_change":
			return entry.title ? { kind: "title", title: entry.title } : undefined;
		case "custom":
			return entry.customType === "user_todo_edit" ? todoRecord(entry.data?.phases) : undefined;
		case "message":
			return entry.message ? messageRecord(entry.message, at) : undefined;
		default:
			return undefined;
	}
}

/**
 * Decides from the first bytes of a JSONL line whether it can produce a record. Tool results and
 * tool-execution markers are most of a session's bytes; skipping them avoids parsing them at all.
 */
function wantedLine(head: string): boolean {
	const typePrefix = '{"type":"';
	if (!head.startsWith(typePrefix)) return true;
	const type = head.slice(typePrefix.length, head.indexOf('"', typePrefix.length));
	switch (type) {
		case "session":
		case "title":
		case "title_change":
			return true;
		case "custom":
			return head.includes('"customType":"user_todo_edit"');
		case "message": {
			const rolePrefix = '"message":{"role":"';
			const at = head.indexOf(rolePrefix);
			if (at < 0) return true;
			const roleStart = at + rolePrefix.length;
			const role = head.slice(roleStart, head.indexOf('"', roleStart));
			if (role === "toolResult") return head.includes('"toolName":"todo"');
			return role === "user" || role === "assistant";
		}
		default:
			return false;
	}
}

/** Parses complete JSONL lines (the buffer must end at a line boundary) into index records. */
export function parseChunk(bytes: Uint8Array): IndexRecord[] {
	const records: IndexRecord[] = [];
	let start = 0;
	while (start < bytes.length) {
		let end = bytes.indexOf(10, start);
		if (end < 0) end = bytes.length;
		if (end > start && wantedLine(latin1.decode(bytes.subarray(start, Math.min(end, start + HEAD_SCAN))))) {
			let entry: RawEntry | undefined;
			try {
				entry = JSON.parse(utf8.decode(bytes.subarray(start, end))) as RawEntry;
			} catch {
				entry = undefined;
			}
			const record = entry && typeof entry === "object" ? recordFromEntry(entry) : undefined;
			if (record) records.push(record);
		}
		start = end + 1;
	}
	return records;
}

function readHead(fd: number): SessionHead | undefined {
	const buffer = new Uint8Array(HEADER_BYTES);
	const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
	let title = "";
	for (const record of parseChunk(buffer.subarray(0, buffer.lastIndexOf(10, read - 1) + 1))) {
		if (record.kind === "title") title = record.title;
		if (record.kind === "header") return { ...record, title: title || record.title };
	}
	return undefined;
}

/**
 * Folds parsed records into the session row (mutated in place) and returns every turn row that
 * changed, in order. `open` is the session's last stored turn, which new records may extend.
 */
export function foldRecords(session: SessionRow, open: TurnRow | undefined, records: IndexRecord[]): TurnRow[] {
	const changed = new Map<number, TurnRow>();
	let turn = open ? { ...open } : undefined;
	let toolLines = turn?.tools ? turn.tools.split("\n").filter(line => !OMITTED_TOOLS.test(line)) : [];
	let files: string[] | undefined;
	for (const record of records) {
		switch (record.kind) {
			case "header":
				session.id ||= record.id;
				session.cwd = record.cwd || session.cwd;
				session.parent = record.parent || session.parent;
				session.title ||= record.title;
				if (!session.created_at) session.created_at = record.at;
				continue;
			case "title":
				session.title = record.title;
				continue;
			case "todo":
				session.todo = record.text;
				continue;
			case "user":
				if (record.steer && turn) {
					turn.user_text = `${turn.user_text}\n\n${record.text}`;
				} else {
					turn = {
						id: 0,
						session_sid: session.sid,
						seq: (turn?.seq ?? session.turn_count) + 1,
						started_at: record.at,
						ended_at: record.at,
						origin: record.origin,
						user_text: record.text,
						reply: "",
						narration: "",
						tools: "",
						tool_count: 0,
						model: "",
					};
					toolLines = [];
				}
				if (turn.user_text.length > USER_HEAD + USER_TAIL + 3) {
					turn.user_text = `${turn.user_text.slice(0, USER_HEAD)}\n…\n${turn.user_text.slice(-USER_TAIL)}`;
				}
				break;
			case "assistant":
				turn ??= {
					id: 0,
					session_sid: session.sid,
					seq: session.turn_count + 1,
					started_at: record.at,
					ended_at: record.at,
					origin: "none",
					user_text: "",
					reply: "",
					narration: "",
					tools: "",
					tool_count: 0,
					model: "",
				};
				if (record.text) {
					if (turn.reply) {
						const narration = turn.narration ? `${turn.narration}\n\n${turn.reply}` : turn.reply;
						turn.narration = narration.length > NARRATION_MAX ? `…${narration.slice(-(NARRATION_MAX - 1))}` : narration;
					}
					turn.reply = clip(record.text, REPLY_MAX);
				}
				if (record.tools.length > 0) {
					toolLines.push(...record.tools);
					turn.tool_count += record.tools.length;
					if (toolLines.length > TOOL_HEAD + TOOL_TAIL) toolLines.splice(TOOL_HEAD, toolLines.length - TOOL_HEAD - TOOL_TAIL);
					const omitted = turn.tool_count - toolLines.length;
					turn.tools = omitted > 0
						? [...toolLines.slice(0, TOOL_HEAD), `… ${omitted} more tool calls`, ...toolLines.slice(TOOL_HEAD)].join("\n")
						: toolLines.join("\n");
				}
				if (record.files.length > 0) {
					files ??= JSON.parse(session.files) as string[];
					for (const file of record.files) {
						const index = files.indexOf(file);
						if (index >= 0) files.splice(index, 1);
						files.push(file);
					}
				}
				turn.model = record.model || turn.model;
				break;
		}
		turn.ended_at = Math.max(turn.ended_at, record.at);
		session.updated_at = Math.max(session.updated_at, record.at);
		changed.set(turn.seq, turn);
	}
	if (files) session.files = JSON.stringify(files.slice(-FILES_MAX));
	if (turn) session.turn_count = Math.max(session.turn_count, turn.seq);
	return [...changed.values()];
}

/** Subagent transcripts live under `<bucket>/<timestamp>_<rootSessionId>/<Agent>.jsonl`. */
function describePath(root: string, file: string): { rootId: string; agent: string } {
	const rel = relative(root, file);
	const parts = rel.split(sep);
	if (rel.startsWith("..") || isAbsolute(rel) || parts.length < 3) return { rootId: "", agent: "" };
	const dir = parts[1] ?? "";
	return { rootId: dir.slice(dir.indexOf("_") + 1), agent: basename(file, ".jsonl") };
}

export class ThreadIndexer {
	readonly db: Database;
	readonly root: string;
	readonly #byFile: Statement<SessionRow, [string]>;
	readonly #identities: Statement<FileIdentity, []>;
	readonly #sameId: Statement<FileIdentity, [string, string]>;
	readonly #lastTurn: Statement<TurnRow, [number]>;
	readonly #insertSession: Statement<null, [string, string, string, string, string, string, string, number, number]>;
	readonly #resetSession: Statement<null, [string, string, string, string, number, number, number]>;
	readonly #saveSession: Statement<null, [string, string, string, string, string, string, number, number, number, number, number]>;
	readonly #markSynced: Statement<null, [number, number, number, string, number, number, string]>;
	readonly #markMissing: Statement<null, [number]>;
	readonly #deleteTurns: Statement<null, [number]>;
	readonly #deleteSession: Statement<null, [number]>;
	readonly #upsertTurn: Statement<null, [number, number, number, number, string, string, string, string, string, number, string]>;
	readonly #getMeta: Statement<{ value: string }, [string]>;
	readonly #setMeta: Statement<null, [string, string]>;

	constructor(db: Database, root: string) {
		this.db = db;
		this.root = root;
		this.#byFile = db.query("SELECT * FROM sessions WHERE file = ?");
		this.#identities = db.query("SELECT sid, file, id, file_ino, file_size, file_mtime, missing FROM sessions");
		this.#sameId = db.query(
			"SELECT sid, file, id, file_ino, file_size, file_mtime, missing FROM sessions WHERE id = ? AND file <> ?",
		);
		this.#lastTurn = db.query("SELECT * FROM turns WHERE session_sid = ? ORDER BY seq DESC LIMIT 1");
		this.#insertSession = db.query(
			`INSERT INTO sessions (file, id, root_id, agent, parent, cwd, title, created_at, file_ino)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#resetSession = db.query(
			`UPDATE sessions SET id = ?, cwd = ?, title = ?, parent = ?, created_at = ?, file_ino = ?,
			 todo = '', files = '[]', updated_at = 0, turn_count = 0, missing = 0, file_size = 0, file_mtime = 0, offset = 0
			 WHERE sid = ?`,
		);
		this.#saveSession = db.query(
			`UPDATE sessions SET id = ?, cwd = ?, title = ?, parent = ?, todo = ?, files = ?,
			 created_at = ?, updated_at = ?, turn_count = ?, offset = ?, missing = 0 WHERE sid = ?`,
		);
		this.#markSynced = db.query(
			`UPDATE sessions SET file_ino = ?1, file_size = ?2, file_mtime = ?3,
			 title = CASE WHEN ?4 <> '' THEN ?4 ELSE title END, missing = 0 WHERE sid = ?5 AND offset >= ?6 AND file = ?7`,
		);
		this.#markMissing = db.query("UPDATE sessions SET missing = 1 WHERE sid = ?");
		this.#deleteTurns = db.query("DELETE FROM turns WHERE session_sid = ?");
		this.#deleteSession = db.query("DELETE FROM sessions WHERE sid = ?");
		this.#upsertTurn = db.query(
			`INSERT INTO turns (session_sid, seq, started_at, ended_at, origin, user_text, reply, narration, tools, tool_count, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (session_sid, seq) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
			 origin = excluded.origin, user_text = excluded.user_text, reply = excluded.reply, narration = excluded.narration,
			 tools = excluded.tools, tool_count = excluded.tool_count, model = excluded.model`,
		);
		this.#getMeta = db.query("SELECT value FROM meta WHERE key = ?");
		this.#setMeta = db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
	}

	getMeta(key: string): string | undefined {
		return this.#getMeta.get(key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.#setMeta.run(key, value);
	}

	/** Atomically claims a periodic job across processes; false when another run started within `intervalMs`. */
	claim(key: string, intervalMs: number, now = Date.now()): boolean {
		const run = this.db.transaction(() => {
			if (now - Number(this.getMeta(key) ?? 0) < intervalMs) return false;
			this.setMeta(key, String(now));
			return true;
		});
		return run.immediate();
	}

	/**
	 * Indexes whatever the file gained since the last sync. Safe to run concurrently from several
	 * processes: each chunk commits only if the stored offset still matches where it started.
	 */
	async syncFile(file: string, deadline = Number.POSITIVE_INFINITY): Promise<FileSyncResult> {
		const result: FileSyncResult = { bytes: 0, turns: 0, complete: true };
		let fd: number;
		try {
			fd = openSync(file, "r");
		} catch {
			return result;
		}
		try {
			const stat = fstatSync(fd);
			const mtime = Math.trunc(stat.mtimeMs);
			const known = this.#byFile.get(file);
			if (known && !known.missing && known.file_ino === stat.ino && known.file_size === stat.size && known.file_mtime === mtime) {
				return result;
			}
			const head = readHead(fd);
			if (!head) return result;
			const sid = this.#prepareRow(file, stat, head);
			let pos = this.#byFile.get(file)?.offset ?? 0;
			let span = CHUNK_BYTES;
			while (pos < stat.size) {
				if (Date.now() > deadline) {
					result.complete = false;
					return result;
				}
				const length = Math.min(span, stat.size - pos);
				const buffer = new Uint8Array(length);
				const read = readSync(fd, buffer, 0, length, pos);
				const end = buffer.lastIndexOf(10, read - 1) + 1;
				if (end === 0) {
					if (pos + read >= stat.size) break;
					span *= 2;
					continue;
				}
				span = CHUNK_BYTES;
				const turns = this.#applyChunk(file, sid, stat.ino, pos, pos + end, parseChunk(buffer.subarray(0, end)));
				if (turns === undefined) {
					const current = this.#byFile.get(file);
					if (!current || current.sid !== sid || current.file_ino !== stat.ino) {
						result.complete = false;
						return result;
					}
					pos = current.offset;
					continue;
				}
				result.bytes += end;
				result.turns += turns;
				pos += end;
				await yieldToLoop();
			}
			this.#markSynced.run(stat.ino, stat.size, mtime, head.title, sid, pos, file);
			return result;
		} finally {
			closeSync(fd);
		}
	}

	/** Syncs every changed session file under the root, newest first, until `deadline`. */
	async syncAll(deadline = Number.POSITIVE_INFINITY): Promise<SyncSummary> {
		const started = Date.now();
		const summary: SyncSummary = { scanned: 0, changed: 0, synced: 0, pending: 0, bytes: 0, turns: 0, ms: 0 };
		let entries: string[];
		try {
			entries = readdirSync(this.root, { recursive: true, encoding: "utf8" });
		} catch {
			return summary;
		}
		const known = new Map<string, FileIdentity>();
		for (const row of this.#identities.all()) known.set(row.file, row);
		const present = new Set<string>();
		const changed: { file: string; mtime: number }[] = [];
		for (const rel of entries) {
			if (!rel.endsWith(".jsonl") || basename(rel).startsWith("__")) continue;
			const file = join(this.root, rel);
			let stat: Stats;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			present.add(file);
			const row = known.get(file);
			const unchanged = row && !row.missing && row.file_ino === stat.ino && row.file_size === stat.size
				&& row.file_mtime === Math.trunc(stat.mtimeMs);
			if (!unchanged) changed.push({ file, mtime: stat.mtimeMs });
		}
		summary.scanned = present.size;
		summary.changed = changed.length;
		changed.sort((a, b) => b.mtime - a.mtime);
		for (const { file } of changed) {
			const result = Date.now() > deadline ? undefined : await this.syncFile(file, deadline);
			if (result?.complete) summary.synced++;
			else summary.pending++;
			summary.bytes += result?.bytes ?? 0;
			summary.turns += result?.turns ?? 0;
		}
		this.#retireMissing(known, present);
		this.setMeta("last_sync", String(Date.now()));
		summary.ms = Date.now() - started;
		return summary;
	}

	/** Creates the row for a new file, or resets it when the file was replaced. Returns its sid. */
	#prepareRow(file: string, stat: Stats, head: SessionHead): number {
		const run = this.db.transaction(() => {
			const row = this.#byFile.get(file);
			if (!row) {
				// A moved session leaves a row pointing at a file that no longer exists.
				for (const stale of this.#sameId.all(head.id, file)) {
					if (!statSync(stale.file, { throwIfNoEntry: false })) this.#removeSession(stale.sid);
				}
				const { rootId, agent } = describePath(this.root, file);
				this.#insertSession.run(file, head.id, rootId, agent, head.parent, head.cwd, head.title, head.at, stat.ino);
				return this.#byFile.get(file)?.sid ?? 0;
			}
			const replaced = row.file_ino !== stat.ino || stat.size < row.offset || (head.id !== "" && row.id !== "" && head.id !== row.id);
			if (replaced) {
				this.#deleteTurns.run(row.sid);
				this.#resetSession.run(head.id, head.cwd, head.title, head.parent, head.at, stat.ino, row.sid);
			}
			return row.sid;
		});
		return run.immediate();
	}

	/** Applies one parsed chunk; undefined when another writer moved the offset or replaced the file. */
	#applyChunk(file: string, sid: number, ino: number, from: number, to: number, records: IndexRecord[]): number | undefined {
		const run = this.db.transaction(() => {
			const session = this.#byFile.get(file);
			if (!session || session.sid !== sid || session.offset !== from || session.file_ino !== ino) return undefined;
			const turns = foldRecords(session, this.#lastTurn.get(sid) ?? undefined, records);
			for (const turn of turns) {
				this.#upsertTurn.run(
					sid,
					turn.seq,
					turn.started_at,
					turn.ended_at,
					turn.origin,
					turn.user_text,
					turn.reply,
					turn.narration,
					turn.tools,
					turn.tool_count,
					turn.model,
				);
			}
			this.#saveSession.run(
				session.id,
				session.cwd,
				session.title,
				session.parent,
				session.todo,
				session.files,
				session.created_at,
				session.updated_at,
				session.turn_count,
				to,
				sid,
			);
			return turns.length;
		});
		return run.immediate();
	}

	#removeSession(sid: number): void {
		this.#deleteTurns.run(sid);
		this.#deleteSession.run(sid);
	}

	/**
	 * Deleted or archived files keep their history searchable unless another file now holds the
	 * session. Files outside the root (custom session dirs) are never listed, so they are left alone.
	 */
	#retireMissing(known: Map<string, FileIdentity>, present: Set<string>): void {
		const run = this.db.transaction(() => {
			for (const stale of known.values()) {
				if (present.has(stale.file) || stale.missing || relative(this.root, stale.file).startsWith("..")) continue;
				// Re-read by file: syncing may have deleted this row and handed its sid to another file.
				const row = this.#byFile.get(stale.file);
				if (!row) continue;
				const moved = row.id !== "" && this.#sameId.all(row.id, row.file).some(other => present.has(other.file));
				if (moved) this.#removeSession(row.sid);
				else this.#markMissing.run(row.sid);
			}
		});
		run.immediate();
	}
}

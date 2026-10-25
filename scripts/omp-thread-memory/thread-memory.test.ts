import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openThreadDb } from "./db.ts";
import type { SessionRow, TurnRow } from "./db.ts";
import { ThreadIndexer } from "./indexer.ts";
import { deepSearch, formatThread, searchThreads } from "./query.ts";
import threadMemory from "./thread-memory.ts";
import type { ExtensionContext, ToolDefinition } from "./thread-memory.ts";

/** Stands in for omp's zod-compatible schema builder; the extension only chains these calls. */
class FakeSchema {
	optional(): FakeSchema {
		return this;
	}

	describe(): FakeSchema {
		return this;
	}
}

/** Writes session files in omp's JSONL layout: title slot, header, then entries. */
class SessionFile {
	readonly lines: string[] = [];
	readonly path: string;
	#clock: number;
	#count = 0;

	constructor(path: string, id: string, cwd: string, title = "", start = Date.parse("2026-10-01T10:00:00Z")) {
		this.path = path;
		this.#clock = start;
		const at = new Date(start).toISOString();
		this.lines.push(JSON.stringify({ type: "title", v: 1, title, source: "user", updatedAt: at, pad: "    " }));
		this.lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd }));
	}

	entry(type: string, fields: Record<string, unknown>): this {
		this.#clock += 60_000;
		const id = (++this.#count).toString(16).padStart(8, "0");
		this.lines.push(JSON.stringify({ type, id, parentId: null, timestamp: new Date(this.#clock).toISOString(), ...fields }));
		return this;
	}

	user(text: string, extra: Record<string, unknown> = {}): this {
		return this.entry("message", { message: { role: "user", content: [{ type: "text", text }], attribution: "user", ...extra } });
	}

	assistant(text: string, calls: [string, Record<string, unknown>][] = []): this {
		const content = [
			{ type: "thinking", thinking: "private reasoning zebra" },
			...(text ? [{ type: "text", text }] : []),
			...calls.map(([name, args], index) => ({ type: "toolCall", id: `call_${index}`, name, arguments: args })),
		];
		return this.entry("message", { message: { role: "assistant", content, model: "test-model" } });
	}

	toolResult(name: string, text: string, details?: unknown): this {
		const message = { role: "toolResult", toolCallId: "call_0", toolName: name, content: [{ type: "text", text }], details };
		return this.entry("message", { message });
	}

	write(lines = this.lines.length): string {
		mkdirSync(join(this.path, ".."), { recursive: true });
		writeFileSync(this.path, this.lines.slice(0, lines).map(line => `${line}\n`).join(""));
		return this.path;
	}
}

let dir: string;
let root: string;
let db: Database;
let indexer: ThreadIndexer;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "thread-memory-"));
	root = join(dir, "sessions");
	db = openThreadDb(join(dir, "threads.db"));
	indexer = new ThreadIndexer(db, root);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function sessionRow(file: string): SessionRow {
	const row = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE file = ?").get(file);
	if (!row) throw new Error(`not indexed: ${file}`);
	return row;
}

function turnsOf(file: string): TurnRow[] {
	return db.query<TurnRow, [number]>("SELECT * FROM turns WHERE session_sid = ? ORDER BY seq").all(sessionRow(file).sid);
}

function loginSession(): SessionFile {
	return new SessionFile(join(root, "-work-app", "2026-10-01_aaaa1111.jsonl"), "aaaa1111-0000-7000-8000-000000000001", "/work/app", "Login redirect fix")
		.user("Fix the login redirect bug")
		.assistant("Looking at the router first.", [["bash", { i: "Running auth tests", command: "bun test auth\n--bail" }]])
		.toolResult("bash", "FAIL auth.test.ts SECRETWORD stack trace")
		.assistant("", [["edit", { i: "Fixing redirect", input: "[src/auth.ts#1A2B]\nPUT 3.=3:\n+return next;" }]])
		.toolResult("todo", "2 items", {
			phases: [{ name: "Fix", tasks: [{ content: "Patch redirect", status: "completed" }, { content: "Check logout flow", status: "in_progress" }] }],
		})
		.assistant("Fixed: the redirect now keeps the query string.")
		.user("also check logout", { steering: true })
		.assistant("Logout checked; it already redirects home.")
		.entry("title_change", { title: "Login redirect fix", source: "user" })
		.user("Deploy it")
		.assistant("Deployed to staging.");
}

test("folds a session into turns: prompts, final reply, earlier notes, tool lines, todo, and edited files", async () => {
	const file = loginSession().write();
	const result = await indexer.syncFile(file);
	expect(result.complete).toBe(true);

	const session = sessionRow(file);
	expect(session).toMatchObject({ title: "Login redirect fix", cwd: "/work/app", turn_count: 2, agent: "" });
	expect(session.todo).toBe("1/2 done\n- [in_progress] Check logout flow (Fix)");
	expect(JSON.parse(session.files)).toEqual(["src/auth.ts"]);

	const [first, second] = turnsOf(file);
	expect(first?.user_text).toBe("Fix the login redirect bug\n\nalso check logout");
	expect(first?.reply).toBe("Logout checked; it already redirects home.");
	expect(first?.narration).toBe("Looking at the router first.\n\nFixed: the redirect now keeps the query string.");
	expect(first?.tools).toBe("bash: Running auth tests · $ bun test auth\nedit: Fixing redirect · src/auth.ts");
	expect(first?.tool_count).toBe(2);
	expect(second).toMatchObject({ seq: 2, user_text: "Deploy it", reply: "Deployed to staging.", model: "test-model" });

	// Tool output and thinking stay out of the index; deep search covers tool output.
	expect(searchThreads(db, { query: "SECRETWORD" }).threads).toHaveLength(0);
	expect(searchThreads(db, { query: "zebra" }).threads).toHaveLength(0);
	expect((await indexer.syncFile(file)).bytes).toBe(0);
});

test("resumes after the last complete line and keeps extending the open turn", async () => {
	const session = loginSession();
	const file = session.path;
	const cut = session.lines.findIndex(line => line.includes("Fixed: the redirect"));
	session.write(cut);
	writeFileSync(file, `${session.lines.slice(0, cut).join("\n")}\n${session.lines[cut]?.slice(0, 40)}`);
	await indexer.syncFile(file);
	expect(turnsOf(file).map(turn => turn.reply)).toEqual(["Looking at the router first."]);

	session.write();
	await indexer.syncFile(file);
	const turns = turnsOf(file);
	expect(turns.map(turn => turn.seq)).toEqual([1, 2]);
	expect(turns[0]?.reply).toBe("Logout checked; it already redirects home.");
	expect(turns[0]?.tool_count).toBe(2);
	expect(searchThreads(db, { query: "query string" }).threads.map(hit => hit.session.file)).toEqual([file]);
});

test("reindexes from scratch when a session file is replaced", async () => {
	const path = join(root, "-work-app", "2026-10-02_bbbb2222.jsonl");
	new SessionFile(path, "bbbb2222-0000-7000-8000-000000000002", "/work/app").user("alpha plan").assistant("alpha done").write();
	await indexer.syncFile(path);
	const replacement = new SessionFile(`${path}.tmp`, "bbbb2222-0000-7000-8000-000000000002", "/work/app")
		.user("beta plan")
		.assistant("beta done")
		.write();
	renameSync(replacement, path);
	await indexer.syncFile(path);
	expect(turnsOf(path).map(turn => turn.user_text)).toEqual(["beta plan"]);
	expect(searchThreads(db, { query: "alpha" }).threads).toHaveLength(0);
	expect(searchThreads(db, { query: "beta" }).threads).toHaveLength(1);
});

test("keyword search ranks threads, widens to any term, and applies directory, age, and subagent filters", async () => {
	const now = Date.parse("2026-10-20T00:00:00Z");
	new SessionFile(join(root, "-work-app", "a.jsonl"), "aaaa-1", "/work/app", "Socket work")
		.user("websocket reconnect backoff is too aggressive")
		.assistant("Raised the reconnect backoff ceiling.")
		.write();
	new SessionFile(join(root, "-work-phone", "b.jsonl"), "bbbb-2", "/work/phone", "", Date.parse("2026-10-18T00:00:00Z"))
		.user("android gradle build fails")
		.assistant("Pinned the gradle plugin; the android build passes.")
		.write();
	new SessionFile(join(root, "-work-phone", "2026_bbbb-2", "Scout.jsonl"), "cccc-3", "/work/phone")
		.user("inspect gradle cache")
		.write();
	await indexer.syncAll();

	expect(searchThreads(db, { query: "gradle android" }, now).threads.map(hit => hit.session.id)).toEqual(["bbbb-2"]);
	expect(searchThreads(db, { query: "gradle websocket" }, now).threads.map(hit => hit.session.id).sort()).toEqual(["aaaa-1", "bbbb-2"]);
	expect(searchThreads(db, { query: "error: gradle (" }, now).threads.map(hit => hit.session.id)).toEqual(["bbbb-2"]);
	expect(searchThreads(db, { query: "gradle", subagents: true }, now).threads.map(hit => hit.session.id).sort()).toEqual(["bbbb-2", "cccc-3"]);
	expect(searchThreads(db, { query: "gradle OR websocket", cwd: "/work/app" }, now).threads.map(hit => hit.session.id)).toEqual(["aaaa-1"]);
	expect(searchThreads(db, { query: "gradle OR websocket", since: "2026-10-17" }, now).threads.map(hit => hit.session.id)).toEqual(["bbbb-2"]);
	expect(searchThreads(db, { query: "socket work" }, now).threads[0]?.hits[0]?.text).toBe("«Socket» «work»");
	expect(searchThreads(db, {}, now).threads.map(hit => hit.session.id)).toEqual(["bbbb-2", "aaaa-1"]);
});

test("regex search matches line by line, honors field and case, and rejects exponential patterns", async () => {
	const file = loginSession().write();
	await indexer.syncFile(file);
	const hit = searchThreads(db, { regex: "redirect.*query" }).threads[0];
	expect(hit?.session.file).toBe(file);
	expect(hit?.hits[0]?.text).toBe("assistant: Fixed: the redirect now keeps the query string.");
	expect(searchThreads(db, { regex: "LOGIN REDIRECT", caseSensitive: true }).threads).toHaveLength(0);
	expect(searchThreads(db, { regex: "bun test auth", field: "user" }).threads).toHaveLength(0);
	expect(searchThreads(db, { regex: "bun test auth", field: "tools" }).threads).toHaveLength(1);
	expect(() => searchThreads(db, { regex: "(a+)+$" })).toThrow("exponential");
	expect(() => searchThreads(db, { regex: "([unclosed" })).toThrow("Invalid regex");
});

test("a deleted session stays searchable but leaves the recent list, and a moved session keeps one row", async () => {
	const kept = new SessionFile(join(root, "-work-app", "kept.jsonl"), "ffff-1", "/work/app").user("pelican migration notes").assistant("noted").write();
	const gone = new SessionFile(join(root, "-work-app", "gone.jsonl"), "ffff-2", "/work/app").user("pelican archive plan").assistant("planned").write();
	await indexer.syncAll();
	rmSync(gone);
	const moved = join(root, "-work-other", "kept.jsonl");
	mkdirSync(join(root, "-work-other"), { recursive: true });
	renameSync(kept, moved);
	await indexer.syncAll();
	expect(searchThreads(db, {}).threads.map(hit => hit.session.file)).toEqual([moved]);
	const found = searchThreads(db, { query: "pelican" }).threads.map(hit => `${hit.session.id}:${hit.session.missing}`);
	expect(found.sort()).toEqual(["ffff-1:0", "ffff-2:1"]);
	expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions WHERE id = 'ffff-1'").get()).toEqual({ n: 1 });
});

test("redacts credentials before they reach the index", async () => {
	const path = join(root, "-work-app", "keys.jsonl");
	new SessionFile(path, "dddd-4", "/work/app")
		.user("use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and Bearer abcdefghijklmnopqrstuvwxyz123456")
		.assistant("Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789")
		.write();
	await indexer.syncFile(path);
	const [turn] = turnsOf(path);
	expect(turn?.user_text).toBe("use [REDACTED] and Bearer [REDACTED]");
	expect(turn?.reply).toBe("Set GITHUB_TOKEN=[REDACTED]");
});

test("thread card shows the resume command, open todo, prompt timeline, and the chosen turns", async () => {
	const file = loginSession().write();
	await indexer.syncFile(file);
	const card = formatThread(db, sessionRow(file), { turns: 1 }, Date.parse("2026-10-02T00:00:00Z"));
	expect(card).toContain("# Login redirect fix");
	expect(card).toContain("resume: cd /work/app && omp -r aaaa1111");
	expect(card).toContain("- [in_progress] Check logout flow (Fix)");
	expect(card).toContain("1. 2026-10-01 10:01 UTC · Fix the login redirect bug also check logout");
	expect(card).toContain("## Turn 2 · 2026-10-01 10:10 UTC · test-model");
	expect(card).not.toContain("## Turn 1 ·");
	expect(formatThread(db, sessionRow(file), { turns: 1, around: 1 }, Date.now())).toContain("## Turn 1 ·");
});

test.if(Boolean(Bun.which("rg") || Bun.which("grep")))("deep search finds tool output the index leaves out", async () => {
	const file = loginSession().write();
	await indexer.syncFile(file);
	const hits = await deepSearch(db, "secretword", {});
	expect(hits.map(hit => hit.session.id)).toEqual(["aaaa1111-0000-7000-8000-000000000001"]);
	expect(hits[0]?.excerpt).toContain("SECRETWORD");
});

test("the extension indexes after each reply, injects its notice once per main session, and searches other sessions", async () => {
	process.env.OMP_THREAD_MEMORY_DB = join(dir, "threads.db");
	process.env.OMP_THREAD_MEMORY_SESSIONS = root;
	const other = loginSession().write();
	const current = new SessionFile(join(root, "-work-app", "current.jsonl"), "eeee5555-0000", "/work/app", "Current").user("hello");
	current.write();

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinition>();
	const schema = new FakeSchema();
	threadMemory({
		zod: { object: () => schema, string: () => schema, number: () => schema, boolean: () => schema, enum: () => schema },
		setLabel() {},
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		sendMessage() {},
	});
	const timers: (() => unknown)[] = [];
	const entries: { type: string; customType?: string }[] = [];
	const ctx = (kind: "main" | "sub"): ExtensionContext => ({
		cwd: "/work/app",
		agent: { kind },
		sessionManager: { getSessionFile: () => current.path, getSessionId: () => "eeee5555-0000", getEntries: () => entries },
		setTimeout: (callback: () => unknown) => timers.push(callback),
		ui: { notify() {} },
	});

	await indexer.syncFile(other);
	const notice = handlers.get("before_agent_start")?.({}, ctx("main")) as { message: { customType: string; content: string } };
	expect(notice.message.customType).toBe("thread-memory.notice");
	expect(notice.message.content).toContain('- aaaa1111 "Login redirect fix" · /work/app');
	expect(notice.message.content).not.toContain("eeee5555");
	entries.push({ type: "custom_message", customType: notice.message.customType });
	expect(handlers.get("before_agent_start")?.({}, ctx("main"))).toBeUndefined();
	expect(handlers.get("before_agent_start")?.({}, ctx("sub"))).toBeUndefined();

	current.assistant("Greetings from the current session about pelicans.").write();
	handlers.get("agent_end")?.({}, ctx("main"));
	for (const timer of timers.splice(0)) await timer();
	expect(searchThreads(db, { query: "pelicans" }).threads.map(hit => hit.session.id)).toEqual(["eeee5555-0000"]);

	const search = await tools.get("thread_search")?.execute("call", { query: "redirect OR pelicans" }, undefined, undefined, ctx("main"));
	expect(search?.content[0]?.text).toContain("aaaa1111-0000-7000-8000-000000000001");
	expect(search?.content[0]?.text).not.toContain("eeee5555-0000 ·");
	const card = await tools.get("thread_open")?.execute("call", { id: "aaaa1111" }, undefined, undefined, ctx("main"));
	expect(card?.content[0]?.text).toContain("# Login redirect fix");
});

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The database is a derived index of the session JSONL files, never a source of truth.
 * Bumping this version drops every table; the next sync rebuilds them from the sessions.
 */
const SCHEMA_VERSION = 1;

export interface ThreadMemoryPaths {
	db: string;
	sessions: string;
}

export function defaultPaths(): ThreadMemoryPaths {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
	return {
		db: process.env.OMP_THREAD_MEMORY_DB || join(agentDir, "thread-memory", "threads.db"),
		sessions: process.env.OMP_THREAD_MEMORY_SESSIONS || join(agentDir, "sessions"),
	};
}

/** One row per session file. `offset` and the file identity columns drive incremental parsing. */
export interface SessionRow {
	sid: number;
	file: string;
	id: string;
	root_id: string;
	agent: string;
	parent: string;
	cwd: string;
	title: string;
	todo: string;
	files: string;
	created_at: number;
	updated_at: number;
	turn_count: number;
	missing: number;
	file_ino: number;
	file_size: number;
	file_mtime: number;
	offset: number;
}

/** One row per user prompt and everything the assistant did until the next prompt. */
export interface TurnRow {
	id: number;
	session_sid: number;
	seq: number;
	started_at: number;
	ended_at: number;
	origin: string;
	user_text: string;
	reply: string;
	narration: string;
	tools: string;
	tool_count: number;
	model: string;
}

const DROP = `
DROP TRIGGER IF EXISTS turns_ai;
DROP TRIGGER IF EXISTS turns_ad;
DROP TRIGGER IF EXISTS turns_au;
DROP TRIGGER IF EXISTS sessions_ai;
DROP TRIGGER IF EXISTS sessions_ad;
DROP TRIGGER IF EXISTS sessions_au;
DROP TABLE IF EXISTS turns_fts;
DROP TABLE IF EXISTS sessions_fts;
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS meta;
`;

const SCHEMA = `
CREATE TABLE sessions (
	sid INTEGER PRIMARY KEY,
	file TEXT NOT NULL UNIQUE,
	id TEXT NOT NULL DEFAULT '',
	root_id TEXT NOT NULL DEFAULT '',
	agent TEXT NOT NULL DEFAULT '',
	parent TEXT NOT NULL DEFAULT '',
	cwd TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	todo TEXT NOT NULL DEFAULT '',
	files TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL DEFAULT 0,
	turn_count INTEGER NOT NULL DEFAULT 0,
	missing INTEGER NOT NULL DEFAULT 0,
	file_ino INTEGER NOT NULL DEFAULT 0,
	file_size INTEGER NOT NULL DEFAULT 0,
	file_mtime INTEGER NOT NULL DEFAULT 0,
	offset INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_id ON sessions(id);
CREATE INDEX sessions_updated ON sessions(updated_at);

CREATE TABLE turns (
	id INTEGER PRIMARY KEY,
	session_sid INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	started_at INTEGER NOT NULL DEFAULT 0,
	ended_at INTEGER NOT NULL DEFAULT 0,
	origin TEXT NOT NULL DEFAULT 'user',
	user_text TEXT NOT NULL DEFAULT '',
	reply TEXT NOT NULL DEFAULT '',
	narration TEXT NOT NULL DEFAULT '',
	tools TEXT NOT NULL DEFAULT '',
	tool_count INTEGER NOT NULL DEFAULT 0,
	model TEXT NOT NULL DEFAULT '',
	UNIQUE (session_sid, seq)
);
CREATE INDEX turns_started ON turns(started_at);

CREATE VIRTUAL TABLE turns_fts USING fts5(
	user_text, reply, narration, tools,
	content='turns', content_rowid='id',
	tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
	INSERT INTO turns_fts(rowid, user_text, reply, narration, tools)
	VALUES (new.id, new.user_text, new.reply, new.narration, new.tools);
END;
CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
	INSERT INTO turns_fts(turns_fts, rowid, user_text, reply, narration, tools)
	VALUES ('delete', old.id, old.user_text, old.reply, old.narration, old.tools);
END;
CREATE TRIGGER turns_au AFTER UPDATE OF user_text, reply, narration, tools ON turns
WHEN old.user_text IS NOT new.user_text OR old.reply IS NOT new.reply
	OR old.narration IS NOT new.narration OR old.tools IS NOT new.tools
BEGIN
	INSERT INTO turns_fts(turns_fts, rowid, user_text, reply, narration, tools)
	VALUES ('delete', old.id, old.user_text, old.reply, old.narration, old.tools);
	INSERT INTO turns_fts(rowid, user_text, reply, narration, tools)
	VALUES (new.id, new.user_text, new.reply, new.narration, new.tools);
END;

CREATE VIRTUAL TABLE sessions_fts USING fts5(
	title, todo,
	content='sessions', content_rowid='sid',
	tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
	INSERT INTO sessions_fts(rowid, title, todo) VALUES (new.sid, new.title, new.todo);
END;
CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
	INSERT INTO sessions_fts(sessions_fts, rowid, title, todo) VALUES ('delete', old.sid, old.title, old.todo);
END;
CREATE TRIGGER sessions_au AFTER UPDATE OF title, todo ON sessions
WHEN old.title IS NOT new.title OR old.todo IS NOT new.todo
BEGIN
	INSERT INTO sessions_fts(sessions_fts, rowid, title, todo) VALUES ('delete', old.sid, old.title, old.todo);
	INSERT INTO sessions_fts(rowid, title, todo) VALUES (new.sid, new.title, new.todo);
END;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Opens (and if needed creates) the index. Safe to call from several processes at once. */
export function openThreadDb(path: string): Database {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path, { create: true });
	db.exec("PRAGMA busy_timeout = 15000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version");
	if (version.get()?.user_version !== SCHEMA_VERSION) {
		const migrate = db.transaction(() => {
			if (version.get()?.user_version === SCHEMA_VERSION) return;
			db.exec(DROP);
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		});
		migrate.immediate();
	}
	chmodSync(path, 0o600);
	return db;
}

import { rmSync, statSync } from "node:fs";
import { defaultPaths, openThreadDb } from "./db.ts";
import { ThreadIndexer } from "./indexer.ts";
import {
	deepSearch,
	describeThread,
	formatDeep,
	formatSearch,
	formatThread,
	resolveThread,
	searchThreads,
	tildify,
} from "./query.ts";
import type { SearchField, SearchOptions } from "./query.ts";

const HELP = `omp-threads: search the conversation of every omp session

Usage:
  omp-threads sync [--rebuild]          index new and changed session files
  omp-threads search <keywords>         ranked keyword search (FTS5 syntax works too)
  omp-threads grep <regex> [--case]     regex over indexed prompts, replies, and tool calls
  omp-threads deep <regex> [--case]     regex over raw session files including tool output (ripgrep or grep -P)
  omp-threads recent                    most recently active threads
  omp-threads show <session-id-or-prefix> [--turns N] [--around TURN]
  omp-threads stats

Filters: --cwd <substring, or . for this directory>  --since <30m|12h|7d|2w|date>
         --field <all|user|assistant|tools>  --limit N  --subagents
Index:   ${tildify(defaultPaths().db)}`;

const VALUED_FLAGS: Record<string, true> = { cwd: true, since: true, field: true, limit: true, turns: true, around: true };
const FIELDS: Record<string, SearchField> = { all: "all", user: "user", assistant: "assistant", tools: "tools" };

const words: string[] = [];
const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i] ?? "";
	if (!arg.startsWith("--")) {
		words.push(arg);
		continue;
	}
	const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
	flags.set(name, VALUED_FLAGS[name] ? (inline ?? argv[++i] ?? "") : "true");
}
const command = words.shift() ?? "help";
const text = words.join(" ").trim();
const now = Date.now();
const paths = defaultPaths();

if (command === "help" || flags.has("help")) {
	console.log(HELP);
	process.exit(0);
}
if (command === "sync" && flags.has("rebuild")) {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.db}${suffix}`, { force: true });
}

const db = openThreadDb(paths.db);
const indexer = new ThreadIndexer(db, paths.sessions);
const cwdFlag = flags.get("cwd");
const limit = Number(flags.get("limit") ?? 10);
const options: SearchOptions = {
	cwd: cwdFlag === "." ? process.cwd() : cwdFlag,
	since: flags.get("since"),
	field: FIELDS[flags.get("field") ?? "all"] ?? "all",
	subagents: flags.has("subagents"),
	caseSensitive: flags.has("case"),
	limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
};
const filters = [
	options.cwd ? `cwd contains ${tildify(options.cwd)}` : "",
	options.since ? `since ${options.since}` : "",
	options.field !== "all" ? `${options.field} text only` : "",
].filter(Boolean);
const scope = filters.length ? ` (${filters.join(", ")})` : "";

try {
	switch (command) {
		case "sync": {
			console.log(`Indexing ${tildify(paths.sessions)} into ${tildify(paths.db)}`);
			const summary = await indexer.syncAll();
			console.log(
				`Scanned ${summary.scanned} session files; ${summary.changed} had new data. Parsed ${(summary.bytes / 1e6).toFixed(1)} MB, ` +
					`updated ${summary.turns} turns in ${(summary.ms / 1000).toFixed(1)} s.` +
					(summary.pending ? ` ${summary.pending} files still pending.` : ""),
			);
			break;
		}
		case "search":
		case "grep": {
			if (!text) throw new Error(`Usage: omp-threads ${command} <${command === "grep" ? "regex" : "keywords"}>`);
			await indexer.syncAll(Date.now() + 10_000);
			const result = searchThreads(db, command === "grep" ? { ...options, regex: text } : { ...options, query: text }, now);
			const what = command === "grep" ? `/${text}/${options.caseSensitive ? "" : "i"}` : `"${text}"`;
			console.log(formatSearch(result, `${result.threads.length} threads match ${what}${scope}`, now));
			break;
		}
		case "deep": {
			if (!text) throw new Error("Usage: omp-threads deep <regex>");
			await indexer.syncAll(Date.now() + 10_000);
			const hits = await deepSearch(db, text, options, now);
			console.log(formatDeep(hits, `${hits.length} session files contain /${text}/ (newest first)`, now));
			break;
		}
		case "recent": {
			await indexer.syncAll(Date.now() + 10_000);
			const result = searchThreads(db, options, now);
			console.log(formatSearch(result, `Most recently active threads${scope}`, now));
			break;
		}
		case "show": {
			const matches = resolveThread(db, text);
			const exact = matches.find(row => row.id === text || row.file === text);
			if (matches.length === 0) throw new Error(`No indexed thread matches "${text}".`);
			if (!exact && matches.length > 1) {
				console.log([`"${text}" matches ${matches.length} threads:`, ...matches.map(row => `- ${describeThread(row, now)}`)].join("\n"));
				break;
			}
			const target = exact ?? matches[0];
			if (!target) break;
			await indexer.syncFile(target.file);
			const fresh = resolveThread(db, target.id).find(row => row.sid === target.sid) ?? target;
			const around = Number(flags.get("around") ?? 0);
			console.log(formatThread(db, fresh, { turns: Number(flags.get("turns") ?? 3), around: around > 0 ? around : undefined }, now));
			break;
		}
		case "stats": {
			const counts = db
				.query<{ main: number; sub: number; missing: number; turns: number }, []>(
					`SELECT sum(agent = '') AS main, sum(agent <> '') AS sub, sum(missing) AS missing,
						(SELECT count(*) FROM turns) AS turns FROM sessions`,
				)
				.get();
			const lastSync = Number(indexer.getMeta("last_sync") ?? 0);
			console.log(
				[
					`index: ${tildify(paths.db)} (${(statSync(paths.db).size / 1e6).toFixed(1)} MB)`,
					`sessions: ${counts?.main ?? 0} main, ${counts?.sub ?? 0} subagent, ${counts?.missing ?? 0} with deleted files`,
					`turns: ${counts?.turns ?? 0}`,
					`last full sync: ${lastSync ? new Date(lastSync).toISOString() : "never"}`,
				].join("\n"),
			);
			break;
		}
		default:
			console.log(HELP);
			process.exitCode = 2;
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	db.close();
}

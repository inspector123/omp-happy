/**
 * End-to-end check of the phone path: runs omp in RPC mode with thread-memory plus a helper that
 * submits a plain-language prompt through `pi.sendUserMessage`, as the Happy bridge does for phone
 * messages. Passes when the hidden thread notice is injected, the agent calls the thread tools on
 * its own, and the finished turn lands in the index without any CLI sync.
 *
 *   bun smoke/phone-path.ts ["prompt"]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { defaultPaths } from "../db.ts";

interface Frame {
	type?: string;
	isTerminal?: boolean;
	message?: {
		role?: string;
		customType?: string;
		content?: string | { type?: string; text?: string; name?: string; arguments?: { path?: string } }[];
	};
}

const prompt =
	process.argv[2] ??
	"Pick up the thread where the archive swipe in the Happy app was made to kill the omp session. Which session was it, and what did I last ask there?";
const here = import.meta.dir;
const omp = Bun.spawn(
	["omp", "--mode", "rpc", "--no-extensions", "-e", join(here, "..", "thread-memory.ts"), "-e", join(here, "phone-prompt.ts"), "--no-title"],
	{ cwd: here, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, THREAD_MEMORY_SMOKE_PROMPT: prompt } },
);
// A stuck run must not hang the check forever.
const watchdog = setTimeout(() => omp.kill(), 300_000);

let notice = false;
let reply = "";
const toolCalls: string[] = [];
const decoder = new TextDecoder();
let pending = "";
for await (const chunk of omp.stdout) {
	pending += decoder.decode(chunk, { stream: true });
	const lines = pending.split("\n");
	pending = lines.pop() ?? "";
	for (const line of lines) {
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch {
			continue;
		}
		const message = frame.message;
		if (frame.type === "message_end" && message?.role === "custom" && message.customType === "thread-memory.notice") notice = true;
		if (frame.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") toolCalls.push(`${block.name ?? "?"} ${block.arguments?.path ?? ""}`.trim());
				if (block.type === "text" && block.text) reply = block.text;
			}
		}
		// Closing stdin disposes the session, which runs the extension's shutdown sync.
		if (frame.type === "agent_end" && frame.isTerminal !== false) omp.stdin.end();
	}
}
await omp.exited;
clearTimeout(watchdog);

const db = new Database(defaultPaths().db, { readonly: true });
const indexed = db
	.query<{ id: string; reply: string }, [string]>(
		"SELECT s.id AS id, t.reply AS reply FROM turns t JOIN sessions s ON s.sid = t.session_sid WHERE t.user_text = ? ORDER BY t.id DESC LIMIT 1",
	)
	.get(prompt);
const usedThreadTools = toolCalls.some(call => call.includes("thread_"));
console.log(`notice injected: ${notice}`);
console.log(`tool calls: ${toolCalls.join(", ") || "none"}`);
console.log(`indexed turn: ${indexed ? `session ${indexed.id}, reply ${indexed.reply.length} chars` : "missing"}`);
console.log(`reply:\n${reply}`);
process.exitCode = notice && usedThreadTools && indexed?.reply ? 0 : 1;

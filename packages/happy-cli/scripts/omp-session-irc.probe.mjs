/**
 * Cross-session IRC probe.
 *
 * Verifies against real omp processes (no mocks of omp itself):
 *   - local unix-socket injection, discovery, delivery, correlated replies,
 *     automatic reply relay, and a two-agent round trip
 *   - Happy bridge injection and automatic reply relay
 *   - merged Happy roster results
 *   - Happy-targeted sends over the bridge hook
 *
 * Usage: bun probe.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const EXTENSION =
	process.env.SIRC_EXTENSION ?? path.join(path.dirname(new URL(import.meta.url).pathname), "omp-session-irc.ts");
const HAPPY_BRIDGE_EXTENSION = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"omp-happy-bridge.mjs",
);
const REGISTRY_DIR = path.join(os.homedir(), ".omp", "run", "session-irc");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sirc-probe-"));
const MODEL = process.env.SIRC_PROBE_MODEL ?? "deepseek/deepseek-flash";
const TURN_TIMEOUT_MS = 240_000;

const results = [];
function record(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(200);
	}
}

class RpcSession {
	constructor(label, happyBridge) {
		this.label = label;
		this.events = [];
		this.text = "";
		this.toolCalls = [];
		this.waiters = [];
		this.pending = new Map();
		this.requestSeq = 0;
		this.happyBridge = happyBridge;
		this.cwd = path.join(TMP, label);
		this.sessionDir = path.join(TMP, `${label}-sessions`);
		fs.mkdirSync(this.cwd, { recursive: true });
		fs.mkdirSync(this.sessionDir, { recursive: true });
	}

	start() {
		this.child = spawn(
			"omp",
			[
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				EXTENSION,
				"-e",
				HAPPY_BRIDGE_EXTENSION,
				"--cwd",
				this.cwd,
				"--session-dir",
				this.sessionDir,
				"--model",
				MODEL,
				"--yolo",
			],
			{
				cwd: this.cwd,
				env: {
					...process.env,
					OMP_HAPPY_BRIDGE_SOCKET: this.happyBridge.socketPath,
					OMP_HAPPY_CONTROL_MODE: "local",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.pid = this.child.pid;
		this.stderr = "";
		this.child.stderr.on("data", chunk => {
			this.stderr += chunk.toString("utf8");
		});
		let buffer = "";
		this.child.stdout.on("data", chunk => {
			buffer += chunk.toString("utf8");
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (line.trim()) this.#onLine(line);
			}
		});
		return this.waitFor(event => event.type === "ready", 60_000, "rpc ready");
	}

	#onLine(line) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		this.events.push(event);
		if (event.type === "response" && event.id && this.pending.has(event.id)) {
			this.pending.get(event.id)(event);
			this.pending.delete(event.id);
		}
		const delta = event.type === "message_update" ? event.assistantMessageEvent?.delta : undefined;
		if (typeof delta === "string") this.text += delta;
		if (event.type === "tool_execution_start") {
			const toolName = event.toolName ?? event.name ?? "?";
			this.toolCalls.push(toolName);
			const dispatched = event.args?.path;
			if (toolName === "write" && typeof dispatched === "string" && dispatched.startsWith("xd://")) {
				this.toolCalls.push(dispatched.slice(5));
			}
		}
		for (const waiter of [...this.waiters]) {
			if (this.events.length - 1 < waiter.fromIndex) continue;
			if (waiter.predicate(event)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				clearTimeout(waiter.timer);
				waiter.resolve(event);
			}
		}
	}

	waitFor(predicate, timeoutMs, label) {
		const found = this.events.find(predicate);
		if (found) return Promise.resolve(found);
		return this.waitForAfter(this.events.length, predicate, timeoutMs, label);
	}

	/** Wait for an event appended at or after `fromIndex` (never a past turn's event). */
	waitForAfter(fromIndex, predicate, timeoutMs, label) {
		const found = this.events.slice(fromIndex).find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`timeout waiting for ${label} in ${this.label} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.waiters.push({ fromIndex, predicate, timer, resolve });
		});
	}

	async call(command, timeoutMs = 120_000) {
		const id = `req_${++this.requestSeq}`;
		const response = new Promise(resolve => this.pending.set(id, resolve));
		this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		const timer = setTimeout(() => this.pending.delete(id), timeoutMs);
		try {
			return await response;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Send a prompt and return the assistant text produced by that turn alone. */
	async prompt(message) {
		const mark = this.text.length;
		const from = this.events.length;
		await this.call({ type: "prompt", message });
		await this.waitForAfter(
			from,
			event => event.type === "agent_end" && event.isTerminal !== false,
			TURN_TIMEOUT_MS,
			"agent_end",
		).catch(error => {
			console.log(`      ${this.label} diagnostics: ${this.describe(from)}`);
			throw error;
		});
		return this.text.slice(mark);
	}

	/** Compact view of what the session did since an event index, for failure output. */
	describe(fromIndex) {
		const events = this.events.slice(fromIndex);
		const kinds = new Map();
		for (const event of events) kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1);
		const tools = events
			.filter(event => event.type === "tool_execution_end")
			.map(event => {
				const text = JSON.stringify(event.result ?? event.error ?? "").slice(0, 200);
				return `${event.toolName ?? "?"} -> ${text}`;
			});
		return `${events.length} events ${JSON.stringify([...kinds])} | tools: ${tools.join(" ; ")} | text tail: ${JSON.stringify(this.text.slice(-200))} | stderr: ${this.stderr.slice(-200)}`;
	}

	async registryRecord(timeoutMs = 30_000) {
		return await waitUntil(() => {
			const file = path.join(REGISTRY_DIR, `${this.pid}.json`);
			try {
				return JSON.parse(fs.readFileSync(file, "utf8"));
			} catch {
				return undefined;
			}
		}, timeoutMs, `${this.label} registry entry`);
	}

	stop() {
		try {
			this.child.stdin.end();
		} catch {}
		try {
			this.child.kill("SIGKILL");
		} catch {}
	}
}

/** A fake Happy CLI bridge that speaks the real newline-delimited child protocol. */
function startFakeHappyBridge() {
	return new Promise((resolve, reject) => {
		const socketPath = path.join(TMP, "happy-bridge.sock");
		const received = [];
		const sockets = new Set();
		const sessionSockets = new Map();
		const sendIds = new Map();
		const roster = [
			{
				sessionId: "remote-probe-session",
				title: "Remote Probe Session",
				active: true,
				machineId: "remote-probe-machine",
			},
		];
		let sentId = 0;
		const server = net.createServer(socket => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => {});
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					if (!line.trim()) continue;
					let frame;
					try {
						frame = JSON.parse(line);
					} catch {
						continue;
					}
					if (
						frame.type === "ready" ||
						frame.type === "peer_send" ||
						frame.type === "peer_roster"
					) {
						received.push({ frame, socket });
					}
					if (frame.type === "ready" && typeof frame.cwd === "string") {
						sessionSockets.set(frame.cwd, socket);
					} else if (frame.type === "peer_roster" && typeof frame.requestId === "string") {
						socket.write(
							`${JSON.stringify({
								type: "peer_roster_result",
								requestId: frame.requestId,
								peers: roster,
							})}\n`,
						);
					} else if (frame.type === "peer_send" && typeof frame.requestId === "string") {
						const id = `fake-happy-message-${++sentId}`;
						sendIds.set(frame.requestId, id);
						socket.write(
							`${JSON.stringify({
								type: "peer_send_result",
								requestId: frame.requestId,
								ok: true,
								id,
								delivered: true,
							})}\n`,
						);
					}
				}
			});
		});
		server.once("error", reject);
		server.listen(socketPath, () => {
			resolve({
				socketPath,
				received,
				roster,
				socketFor(cwd) {
					return sessionSockets.get(cwd);
				},
				messageIdFor(requestId) {
					return sendIds.get(requestId);
				},
				send(cwd, frame) {
					const socket = sessionSockets.get(cwd);
					if (!socket) throw new Error(`no Happy bridge connection for ${cwd}`);
					socket.write(`${JSON.stringify(frame)}\n`);
				},
				close() {
					for (const socket of sockets) socket.destroy();
					server.close();
				},
			});
		});
	});
}

/** A non-agent peer: a listening socket plus a registry entry, so agents see it as a session. */
function startFakePeer(name) {
	return new Promise(resolve => {
		const socketPath = path.join(TMP, `${name}.sock`);
		const received = [];
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					try {
						received.push({ frame: JSON.parse(line), socket });
					} catch {}
				}
			});
			socket.on("error", () => {});
		});
		server.listen(socketPath, () => {
			fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
			fs.writeFileSync(
				path.join(REGISTRY_DIR, `${process.pid}.json`),
				JSON.stringify({
					pid: process.pid,
					name,
					cwd: TMP,
					sessionId: null,
					socket: socketPath,
					startedAt: Date.now(),
				}),
			);
			resolve({
				name,
				socketPath,
				server,
				received,
				reply(frame, body) {
					const entry = received.find(candidate => candidate.frame.id === frame.id);
					if (!entry) throw new Error(`no connection for frame ${frame.id}`);
					entry.socket.write(
						`${JSON.stringify({
							v: 1,
							id: `${name}-reply`,
							from: name,
							to: frame.from,
							body,
							ts: Date.now(),
							replyTo: frame.id,
						})}\n`,
					);
				},
			});
		});
	});
}

async function main() {
	const happyBridge = await startFakeHappyBridge();
	const a = new RpcSession("A", happyBridge);
	const b = new RpcSession("B", happyBridge);
	let fakePeer;
	try {
		await a.start();
		const stateAtStartup = await a.call({ type: "get_state" });
		const startupTools = (stateAtStartup.data?.dumpTools ?? []).map(tool => tool.name);
		console.log(`      startup tools: ${startupTools.join(", ")}`);
		const recordA = await a.registryRecord();
		await waitUntil(() => happyBridge.socketFor(a.cwd), 30_000, "A Happy bridge connection");

		// Happy inbound: duplicate cold/live delivery starts one turn and relays one correlated answer.
		{
			const eventMark = a.events.length;
			const textMark = a.text.length;
			const bridgeMark = happyBridge.received.length;
			const message = {
				type: "peer_message",
				id: "probe-happy-inbound-1",
				from: "remote-sender-session",
				fromTitle: "Remote Sender",
				body: "Reply with the exact word REMOTE-PONG.",
				replyTo: null,
				ts: Date.now(),
			};
			happyBridge.send(a.cwd, message);
			happyBridge.send(a.cwd, message);
			const started = await a
				.waitForAfter(eventMark, event => event.type === "agent_start", TURN_TIMEOUT_MS, "agent turn from Happy message")
				.then(() => true)
				.catch(error => error.message);
			await a.waitForAfter(eventMark, event => event.type === "agent_end", TURN_TIMEOUT_MS, "Happy agent_end");
			const relayed = await waitUntil(
				() =>
					happyBridge.received
						.slice(bridgeMark)
						.find(
							entry =>
								entry.frame.type === "peer_send" &&
								entry.frame.to === "happy:remote-sender-session" &&
								entry.frame.replyTo === message.id,
						),
				30_000,
				"Happy automatic reply relay",
			).catch(error => error);
			const matchingRelays = happyBridge.received
				.slice(bridgeMark)
				.filter(entry => entry.frame.type === "peer_send" && entry.frame.replyTo === message.id);
			const answer = a.text.slice(textMark);
			record(
				"a Happy peer message starts one real turn and relays its correlated answer",
				started === true &&
					answer.toUpperCase().includes("REMOTE-PONG") &&
					Boolean(relayed?.frame) &&
					matchingRelays.length === 1,
				relayed?.frame
					? `bridge received: ${JSON.stringify(relayed.frame)}`
					: `${String(relayed)} | assistant: ${JSON.stringify(answer.slice(-200))}`,
			);
		}

		// Happy roster: the bridge result is merged into the sirc list output.
		{
			const eventMark = a.events.length;
			const answer = await a.prompt(
				'Call the sirc tool with op="list". Copy the complete tool result into your answer exactly.',
			);
			const toolResults = a.events
				.slice(eventMark)
				.filter(event => event.type === "tool_execution_end")
				.map(event => event.result);
			const observed = JSON.stringify(toolResults);
			const evidence = `${observed}\n${answer}`;
			record(
				"Happy roster peers appear in sirc op=list",
				evidence.includes("happy:remote-probe-session") &&
					evidence.includes("title=Remote Probe Session") &&
					evidence.includes("state=active"),
				`tool result: ${observed.slice(-500)} | assistant: ${JSON.stringify(answer.slice(-200))}`,
			);
		}

		// Happy send: an exact remote handle becomes a peer_send bridge frame.
		{
			const bridgeMark = happyBridge.received.length;
			const body = "hello through the Happy bridge";
			const turn = a.prompt(
				`Call the sirc tool once with op="send", to="happy:remote-probe-session", ` +
					`message="${body}", await=true. After it returns, repeat the reply verbatim.`,
			);
			const delivered = await waitUntil(
				() =>
					happyBridge.received
						.slice(bridgeMark)
						.find(
							entry =>
								entry.frame.type === "peer_send" &&
								entry.frame.to === "happy:remote-probe-session" &&
								entry.frame.body === body,
						),
				90_000,
				"Happy peer_send frame",
			).catch(error => error);
			const resultId = delivered?.frame
				? await waitUntil(
						() => happyBridge.messageIdFor(delivered.frame.requestId),
						30_000,
						"Happy peer_send_result id",
					)
				: undefined;
			if (resultId) {
				happyBridge.send(a.cwd, {
					type: "peer_message",
					id: "probe-happy-send-reply",
					from: "remote-probe-session",
					fromTitle: "Remote Probe Session",
					body: "ACK-FROM-HAPPY-PROBE",
					replyTo: resultId,
					ts: Date.now(),
				});
			}
			const answer = await turn;
			record(
				"sirc op=send to a Happy peer emits a peer_send bridge frame",
				Boolean(delivered?.frame) && answer.includes("ACK-FROM-HAPPY-PROBE"),
				delivered?.frame
					? `bridge received: ${JSON.stringify(delivered.frame)} | assistant: ${JSON.stringify(answer.slice(-200))}`
					: `${String(delivered)} | assistant: ${JSON.stringify(answer.slice(-300))}`,
			);
		}


		// 1) Inbound: a foreign process writes a frame straight to A's socket.
		{
			const socket = net.createConnection(recordA.socket);
			await new Promise((resolve, reject) => {
				socket.on("connect", resolve);
				socket.on("error", reject);
			});
			socket.write(
				`${JSON.stringify({ v: 1, id: "probe-inbound-1", from: "probe", body: "Reply with the exact word PONG.", ts: Date.now() })}\n`,
			);
			const from = a.events.length;
			const started = await a
				.waitForAfter(from, event => event.type === "agent_start", TURN_TIMEOUT_MS, "agent turn from socket message")
				.then(() => true)
				.catch(error => error.message);
			await a.waitForAfter(from, event => event.type === "agent_end", TURN_TIMEOUT_MS, "agent_end").catch(() => {});
			socket.end();
			record(
				"a message from another process starts a turn in a live session",
				started === true && a.text.toUpperCase().includes("PONG"),
				started === true ? `assistant: ${JSON.stringify(a.text.slice(-200))}` : String(started),
			);
		}

		// 2) Agent-side discovery + delivery to a peer, with reply correlation.
		{
			fakePeer = await startFakePeer("probe-peer");
			const turn = a.prompt(
				'Use the sirc tool. First op="list". Then op="send" with to="probe-peer", ' +
					'message="hello from session A", await=true. Then state the reply you received, verbatim.',
			);
			const delivered = await waitUntil(
				() => fakePeer.received.find(entry => entry.frame.body === "hello from session A"),
				90_000,
				"message at the peer",
			).catch(error => error);
			if (delivered?.frame) fakePeer.reply(delivered.frame, "ACK-FROM-PROBE");
			const answer = await turn.catch(error => {
				console.log(`      A diagnostics: ${a.describe(0)}`);
				console.log(`      frames at fake peer: ${JSON.stringify(fakePeer.received.map(entry => entry.frame))}`);
				throw error;
			});
			record(
				"agent lists a peer in another process and delivers a message to it",
				Boolean(delivered?.frame),
				delivered?.frame ? `peer received: ${JSON.stringify(delivered.frame)}` : String(delivered),
			);
			if (delivered?.frame) fakePeer.reply(delivered.frame, "ACK-FROM-PROBE");
			const gotReply = await waitUntil(() => a.text.includes("ACK-FROM-PROBE"), 120_000, "reply text on A").catch(
				() => false,
			);
			record(
				"the awaited reply reaches the sending agent",
				Boolean(gotReply),
				`assistant: ${JSON.stringify((a.text.includes("ACK-FROM-PROBE") ? a.text : answer).slice(-300))}`,
			);
			record(
				"the extension's sirc tool is callable by the session's model",
				a.toolCalls.includes("sirc"),
				`tool calls: ${a.toolCalls.join(", ")} (note: RPC get_state.dumpTools lists only core tools)`,
			);
		}

		// 3) Two live omp sessions: A asks B, B's agent answers unprompted.
		{
			await b.start();
			const recordB = await b.registryRecord();
			const eventsBefore = b.events.length;
			const answer = await a.prompt(
				`Use the sirc tool: op="send", to="${recordB.name}#${recordB.pid}", ` +
					'message="What is 17+25? Reply with just the number.", await=true. ' +
					"Then tell me the number the other session sent back.",
			);
			record(
				"a second live omp session answered the first session's agent, unprompted",
				answer.includes("42") || a.text.includes("42"),
				`A assistant: ${JSON.stringify(answer.slice(-300))}`,
			);
			record(
				"the peer session ran a real agent turn from the injected message",
				b.events.slice(eventsBefore).some(event => event.type === "agent_start") && b.text.includes("42"),
				`B tool calls: ${b.toolCalls.join(", ") || "(none)"} | B assistant: ${JSON.stringify(b.text.slice(-160))}`,
			);
		}

		// 4) Roster: one agent sees both the peer session and the fake peer.
		{
			const answer = await a.prompt('Call the sirc tool with op="list". Report every peer id you see, one per line.');
			record(
				"one agent discovers every live session on the machine",
				answer.includes(`${b.pid}`) && answer.includes("probe-peer"),
				`assistant: ${JSON.stringify(answer.slice(-300))}`,
			);
		}
	} finally {
		a.stop();
		b.stop();
		fakePeer?.server.close();
		happyBridge.close();
		fs.rmSync(path.join(REGISTRY_DIR, `${process.pid}.json`), { force: true });
		fs.rmSync(path.join(REGISTRY_DIR, `${a.pid}.json`), { force: true });
		fs.rmSync(path.join(REGISTRY_DIR, `${b.pid}.json`), { force: true });
	}

	const failed = results.filter(result => !result.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
	console.error(`probe crashed: ${error?.stack ?? error}`);
	process.exit(2);
});

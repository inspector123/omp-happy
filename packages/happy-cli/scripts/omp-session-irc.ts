/**
 * session-irc — cross-process IRC for omp sessions.
 *
 * The built-in `hub` peer bus (packages/coding-agent/src/irc/bus.ts) and the
 * AgentRegistry it resolves peers through are process-global: two `omp`
 * processes in different terminals cannot see each other. This extension adds
 * the missing transport.
 *
 * Each session:
 *   - publishes itself to ~/.omp/run/session-irc/<pid>.json
 *   - listens on ~/.omp/run/session-irc/<pid>.sock (unix domain socket, 0600)
 *   - accepts newline-delimited JSON frames
 *   - injects an inbound frame into its own conversation with
 *     pi.sendUserMessage(), which is the documented extension seam for pushing
 *     an external message into a live session (idle -> starts a turn,
 *     streaming -> queued as a steer)
 *   - exposes the `sirc` tool so the agent can list peers and send/reply
 *   - answers the sender automatically: the turn's final assistant text is
 *     relayed back over the frame's socket when the turn ends, so a peer
 *     answers with plain prose instead of having to call a tool
 *
 * Local frames stay on the user-private unix sockets. Happy-backed sessions
 * also use the in-process bridge hook to reach sessions on other machines.
 *
 * Wiring in this repo: `omp-happy-launcher.sh` passes this file with
 * `--extension` unless `OMP_HAPPY_SESSION_IRC=0`, so every session started
 * through the happy launcher participates. Plain (non-happy) `omp` sessions
 * join by passing `-e <this file>` or symlinking it into
 * ~/.omp/agent/extensions. Peers are named by session title, which is what the
 * happy app shows for the session.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PROTOCOL = 1;
const REGISTRY_DIR = path.join(os.homedir(), ".omp", "run", "session-irc");
const AWAIT_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 3_000;
const HAPPY_RESULT_TIMEOUT_MS = 15_000;
const MAX_SEEN_MESSAGE_IDS = 200;

interface Frame {
	v: number;
	id: string;
	from: string;
	to?: string;
	body: string;
	ts: number;
	replyTo?: string;
}

/** The `pi.typebox.Type` builder surface this extension uses. */
interface TypeBuilder {
	Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
	Union(variants: unknown[]): unknown;
	Literal(value: string): unknown;
	String(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Optional(schema: unknown): unknown;
}

interface SessionContext {
	cwd?: string;
	ui?: { notify?: (message: string, level?: string) => void };
	sessionManager?: { getSessionId?: () => string | null };
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

/** The subset of ExtensionAPI (packages/coding-agent/src/extensibility/extensions/types.ts) used here. */
interface SessionIrcHost {
	setLabel(label: string): void;
	sendUserMessage(content: string, options?: { attribution?: string; deliverAs?: string }): void;
	on(event: string, handler: (event: unknown, ctx: SessionContext) => unknown): void;
	getSessionName?(): string | null | undefined;
	typebox?: { Type: TypeBuilder };
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		strict: boolean;
		defaultInactive: boolean;
		execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
	}): void;
}

interface Peer {
	pid: number;
	name: string;
	cwd: string;
	sessionId: string | null;
	socket: string;
	startedAt: number;
}

interface HappyRosterPeer {
	sessionId: string;
	title: string;
	active: boolean;
	machineId: string | null;
}

interface HappyPeerMessage {
	id: string;
	from: string;
	fromTitle: string;
	body: string;
	replyTo: string | null;
	ts: number;
}

interface HappyPeerResult {
	type: "peer_send_result" | "peer_roster_result";
	requestId: string;
	ok?: boolean;
	id?: string;
	delivered?: boolean;
	error?: string;
	peers?: unknown[];
}

interface HappyPeerHook {
	send(request: { to: string; body: string; replyTo?: string; requestId: string }): void;
	roster(requestId: string): void;
	onResult(handler: (frame: HappyPeerResult) => void): void;
	onMessage(handler: (message: HappyPeerMessage) => void): void;
}

declare global {
	var __ompHappyPeer: HappyPeerHook | undefined;
}

/**
 * A peer message that this session still owes an answer to. The obligation is
 * discharged either by the agent calling `sirc` with the matching `replyTo`, or
 * by the relay in the `agent_end` handler below, which sends the turn's final
 * assistant text back to the sender over the transport it arrived on.
 */
type ReplyObligation =
	| { transport: "local"; to: string; id: string; socket: net.Socket }
	| { transport: "happy"; sessionId: string; id: string };

/** Final assistant text of a finished turn, used to answer the peers that wrote to it. */
function lastAssistantText(event: unknown): string {
	const messages = (event as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: unknown; content?: unknown } | null;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((block: { type?: unknown; text?: unknown }) => {
				const candidate = block as { type?: unknown; text?: unknown };
				return candidate?.type === "text" && typeof candidate.text === "string";
			})
			.map((block: { text: string }) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function ensureRegistryDir(): void {
	fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
	fs.chmodSync(REGISTRY_DIR, 0o700);
}

function peerLabel(peer: Peer): string {
	return `${peer.name}#${peer.pid}`;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Registry file that is not our own, points at a live pid, and parses. */
function listPeers(): Peer[] {
	ensureRegistryDir();
	const peers: Peer[] = [];
	for (const entry of fs.readdirSync(REGISTRY_DIR)) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(REGISTRY_DIR, entry);
		try {
			const peer = JSON.parse(fs.readFileSync(file, "utf8")) as Peer;
			if (typeof peer?.pid !== "number" || typeof peer?.socket !== "string") throw new Error("malformed");
			if (!pidAlive(peer.pid)) throw new Error("stale");
			if (!fs.existsSync(peer.socket)) throw new Error("no socket");
			peers.push(peer);
		} catch {
			try {
				fs.rmSync(file, { force: true });
				fs.rmSync(file.replace(/\.json$/, ".sock"), { force: true });
			} catch {}
		}
	}
	return peers.sort((a, b) => a.startedAt - b.startedAt);
}

export default function sessionIrcExtension(pi: SessionIrcHost) {
	const Type = pi.typebox?.Type;
	if (!Type) return;
	const server = net.createServer();
	const connections = new Set<net.Socket>();
	const waiters = new Map<string, (text: string) => void>();
	const happyResultWaiters = new Map<string, (frame: HappyPeerResult) => void>();
	const replyObligations: ReplyObligation[] = [];
	const seenInboundIds = new Set<string>();
	const seenInboundOrder: string[] = [];
	let self: Peer | null = null;
	let counter = 0;
	let notify: ((text: string, level?: string) => void) | null = null;
	let happyPeer: HappyPeerHook | undefined;
	let happyPeerPoll: NodeJS.Timeout | undefined;

	const nextId = (): string => `irc-${process.pid}-${++counter}`;

	function rememberInbound(id: string): boolean {
		if (seenInboundIds.has(id)) return false;
		seenInboundIds.add(id);
		seenInboundOrder.push(id);
		if (seenInboundOrder.length > MAX_SEEN_MESSAGE_IDS) {
			const expired = seenInboundOrder.shift();
			if (expired !== undefined) seenInboundIds.delete(expired);
		}
		return true;
	}

	function inject(frame: Frame, fromTitle?: string): void {
		const source = fromTitle?.trim() ? `${fromTitle} (${frame.from})` : frame.from;
		const hint =
			`\n\n(This message came from another omp session over session IRC. Your reply is relayed back to ${frame.from} automatically when this turn ends. ` +
			`To send follow-ups or extra messages yourself: sirc op="send", to="${frame.from}", replyTo="${frame.id}", message="...")`;
		pi.sendUserMessage(`[irc from ${source} id=${frame.id}] ${frame.body}${hint}`, { attribution: "agent" });
	}

	function sendDeliveryFailure(obligation: ReplyObligation, message: string): void {
		if (obligation.transport === "local") {
			obligation.socket.write(
				`${JSON.stringify({
					v: PROTOCOL,
					id: nextId(),
					from: self ? peerLabel(self) : `pid-${process.pid}`,
					to: obligation.to,
					body: message,
					ts: Date.now(),
					replyTo: obligation.id,
				})}\n`,
			);
			return;
		}
		attachHappyPeer()?.send({
			requestId: nextId(),
			to: `happy:${obligation.sessionId}`,
			body: message,
			replyTo: obligation.id,
		});
	}

	function handleFrame(frame: Frame, obligation: ReplyObligation, fromTitle?: string): void {
		if (
			frame.v !== PROTOCOL ||
			typeof frame.body !== "string" ||
			typeof frame.id !== "string" ||
			typeof frame.from !== "string"
		) {
			return;
		}
		if (!rememberInbound(frame.id)) return;
		if (frame.replyTo) {
			const settleWaiter = waiters.get(frame.replyTo);
			if (settleWaiter) {
				waiters.delete(frame.replyTo);
				settleWaiter(`reply from ${frame.from}: ${frame.body}`);
				return;
			}
		}
		try {
			replyObligations.push(obligation);
			inject(frame, fromTitle);
			notify?.(`irc: ${frame.from} -> this session`, "info");
		} catch (error) {
			sendDeliveryFailure(obligation, `delivery failed: ${(error as Error).message}`);
		}
	}

	function handleLocalFrame(frame: Frame, socket: net.Socket): void {
		handleFrame(frame, { transport: "local", to: frame.from, id: frame.id, socket });
	}

	function handleHappyMessage(message: HappyPeerMessage): void {
		if (
			typeof message.id !== "string" ||
			typeof message.from !== "string" ||
			typeof message.fromTitle !== "string" ||
			typeof message.body !== "string" ||
			(message.replyTo !== null && typeof message.replyTo !== "string") ||
			typeof message.ts !== "number"
		) {
			return;
		}
		const frame: Frame = {
			v: PROTOCOL,
			id: message.id,
			from: `happy:${message.from}`,
			body: message.body,
			ts: message.ts,
			...(message.replyTo ? { replyTo: message.replyTo } : {}),
		};
		handleFrame(
			frame,
			{ transport: "happy", sessionId: message.from, id: message.id },
			message.fromTitle,
		);
	}

	function handleHappyResult(frame: HappyPeerResult): void {
		if (
			(frame.type !== "peer_send_result" && frame.type !== "peer_roster_result") ||
			typeof frame.requestId !== "string"
		) {
			return;
		}
		happyResultWaiters.get(frame.requestId)?.(frame);
	}

	function attachHappyPeer(): HappyPeerHook | undefined {
		const candidate = globalThis.__ompHappyPeer;
		if (!candidate) return happyPeer;
		if (candidate === happyPeer) return happyPeer;
		if (
			typeof candidate.send !== "function" ||
			typeof candidate.roster !== "function" ||
			typeof candidate.onResult !== "function" ||
			typeof candidate.onMessage !== "function"
		) {
			return happyPeer;
		}
		happyPeer = candidate;
		candidate.onResult(handleHappyResult);
		candidate.onMessage(handleHappyMessage);
		if (happyPeerPoll) {
			clearInterval(happyPeerPoll);
			happyPeerPoll = undefined;
		}
		return happyPeer;
	}

	function startHappyPeerDiscovery(): void {
		if (attachHappyPeer() || happyPeerPoll || !process.env.OMP_HAPPY_BRIDGE_SOCKET) return;
		happyPeerPoll = setInterval(() => {
			attachHappyPeer();
		}, 25);
		happyPeerPoll.unref();
	}

	function requestHappyResult(
		hook: HappyPeerHook,
		requestId: string,
		expectedType: HappyPeerResult["type"],
		dispatch: () => void,
	): Promise<HappyPeerResult> {
		return new Promise(resolve => {
			let timer: NodeJS.Timeout;
			const finish = (frame: HappyPeerResult): void => {
				clearTimeout(timer);
				happyResultWaiters.delete(requestId);
				resolve(frame);
			};
			timer = setTimeout(
				() =>
					finish({
						type: expectedType,
						requestId,
						ok: false,
						error: "bridge request timed out",
					}),
				HAPPY_RESULT_TIMEOUT_MS,
			);
			happyResultWaiters.set(requestId, finish);
			try {
				dispatch();
			} catch (error) {
				finish({
					type: expectedType,
					requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	function decodeHappyPeers(values: unknown[] | undefined): HappyRosterPeer[] {
		if (!Array.isArray(values)) return [];
		const peers: HappyRosterPeer[] = [];
		for (const value of values) {
			if (!value || typeof value !== "object") continue;
			const candidate = value as Record<string, unknown>;
			if (
				typeof candidate.sessionId !== "string" ||
				typeof candidate.title !== "string" ||
				typeof candidate.active !== "boolean" ||
				(candidate.machineId !== null && typeof candidate.machineId !== "string")
			) {
				continue;
			}
			peers.push({
				sessionId: candidate.sessionId,
				title: candidate.title,
				active: candidate.active,
				machineId: candidate.machineId,
			});
		}
		return peers;
	}

	async function requestHappyRoster(hook = attachHappyPeer()): Promise<HappyRosterPeer[]> {
		if (!hook) return [];
		const requestId = nextId();
		const result = await requestHappyResult(hook, requestId, "peer_roster_result", () => hook.roster(requestId));
		if (result.type !== "peer_roster_result") return [];
		return decodeHappyPeers(result.peers).filter(peer => peer.sessionId !== self?.sessionId);
	}

	async function resolveHappyDestinations(target: string): Promise<HappyRosterPeer[]> {
		const hook = attachHappyPeer();
		if (!hook) return [];
		if (target.startsWith("happy:")) {
			const sessionId = target.slice("happy:".length);
			return sessionId
				? [{ sessionId, title: sessionId, active: true, machineId: null }]
				: [];
		}
		const peers = await requestHappyRoster(hook);
		return peers.filter(
			peer => target === "all" || target === peer.sessionId || target === peer.title,
		);
	}

	pi.setLabel("Session IRC");

	pi.registerTool({
		name: "sirc",
		label: "Session IRC",
		description:
			"Message another live omp session, either a local process or a Happy session, or list the sessions that are reachable. " +
			"op=list shows local peers as name#pid and remote peers as happy:sessionId. op=send delivers a message to a peer's conversation: an idle peer starts a turn, a busy peer receives it as a steer at its next step. " +
			"Pass replyTo to answer a message you received, and await=true to block until that peer answers you.",
		parameters: Type.Object(
			{
				op: Type.Union([Type.Literal("list"), Type.Literal("send")]),
				to: Type.Optional(
					Type.String({ description: "peer name#pid, name, pid, happy:sessionId, session id, or exact title; \"all\" broadcasts" }),
				),
				message: Type.Optional(Type.String({ description: "message body" })),
				replyTo: Type.Optional(Type.String({ description: "id of the message being answered" })),
				await: Type.Optional(Type.Boolean({ description: "wait for the peer's reply before returning" })),
			},
			{ additionalProperties: false },
		),
		strict: true,
		defaultInactive: false,
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const op = String(params.op ?? "");
			if (op === "list") {
				const peers = listPeers().filter(peer => peer.pid !== process.pid);
				const happyPeers = await requestHappyRoster();
				const lines = peers.map(
					peer => `${peerLabel(peer)}\tcwd=${peer.cwd}\tsession=${peer.sessionId ?? "?"}\tagent=omp`,
				);
				lines.push(
					...happyPeers.map(
						peer =>
							`happy:${peer.sessionId}\ttitle=${peer.title}\tstate=${peer.active ? "active" : "inactive"}`,
					),
				);
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "No other omp sessions are reachable." }],
					details: happyPeers.length ? { op, peers, happyPeers } : { op, peers },
				};
			}

			const body = typeof params.message === "string" ? params.message : "";
			if (!body.trim()) {
				return { content: [{ type: "text", text: "sirc: `message` is required for op=send." }], details: { op } };
			}
			const target = typeof params.to === "string" ? params.to.trim() : "";
			const replyTo = typeof params.replyTo === "string" && params.replyTo ? params.replyTo : undefined;
			const frame: Frame = {
				v: PROTOCOL,
				id: nextId(),
				from: self ? peerLabel(self) : `pid-${process.pid}`,
				to: target,
				body,
				ts: Date.now(),
				...(replyTo ? { replyTo } : {}),
			};
			if (replyTo) {
				for (let index = replyObligations.length - 1; index >= 0; index--) {
					if (replyObligations[index].id === replyTo) replyObligations.splice(index, 1);
				}
			}

			const destinations = target.startsWith("happy:")
				? []
				: listPeers().filter(peer => {
						if (peer.pid === process.pid) return false;
						if (target === "all") return true;
						return (
							target === String(peer.pid) ||
							target === peer.name ||
							target === peerLabel(peer) ||
							target === `@${peer.name}`
						);
					});
			const happyDestinations = await resolveHappyDestinations(target);
			const destinationCount = destinations.length + happyDestinations.length;
			if (destinationCount === 0) {
				return {
					content: [{ type: "text", text: `sirc: no reachable peer matches "${target}".` }],
					details: { op, frame },
				};
			}

			const results: string[] = [];
			for (const peer of destinations) {
				const reply = await sendToPeer(peer, frame, params.await === true && destinationCount === 1);
				results.push(reply);
			}
			for (const peer of happyDestinations) {
				const reply = await sendToHappyPeer(peer, frame, params.await === true && destinationCount === 1);
				results.push(reply);
			}
			return { content: [{ type: "text", text: results.join("\n") }], details: { op, frame, deliveries: results } };
		},
	});

	pi.on("session_start", async (_event: unknown, ctx: SessionContext) => {
		notify = typeof ctx?.ui?.notify === "function" ? ctx.ui.notify.bind(ctx.ui) : null;
		attachHappyPeer();
		ensureRegistryDir();
		const socketPath = path.join(REGISTRY_DIR, `${process.pid}.sock`);
		const jsonPath = path.join(REGISTRY_DIR, `${process.pid}.json`);
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {}
		server.on("connection", socket => {
			connections.add(socket);
			socket.on("close", () => connections.delete(socket));
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
					try {
						handleLocalFrame(JSON.parse(line) as Frame, socket);
					} catch {}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				try {
					fs.chmodSync(socketPath, 0o600);
				} catch {}
				resolve();
			});
		});
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		self = {
			pid: process.pid,
			name: (() => {
				try {
					const name = pi.getSessionName?.();
					return typeof name === "string" && name.trim() ? name.trim().slice(0, 48) : path.basename(cwd) || "omp";
				} catch {
					return path.basename(cwd) || "omp";
				}
			})(),
			cwd,
			sessionId: (() => {
				try {
					return ctx?.sessionManager?.getSessionId?.() ?? null;
				} catch {
					return null;
				}
			})(),
			socket: socketPath,
			startedAt: Date.now(),
		};
		fs.writeFileSync(jsonPath, JSON.stringify(self), { mode: 0o600 });
		notify?.(`session-irc listening as ${peerLabel(self)}`, "info");
	});

	pi.on("agent_end", (event: unknown) => {
		if (replyObligations.length === 0) return;
		const text = lastAssistantText(event) || "(this session finished the turn without a text answer)";
		for (const obligation of replyObligations.splice(0, replyObligations.length)) {
			try {
				if (obligation.transport === "local") {
					const reply: Frame = {
						v: PROTOCOL,
						id: nextId(),
						from: self ? peerLabel(self) : `pid-${process.pid}`,
						to: obligation.to,
						body: text,
						ts: Date.now(),
						replyTo: obligation.id,
					};
					if (obligation.socket.writable) obligation.socket.write(`${JSON.stringify(reply)}\n`);
				} else {
					attachHappyPeer()?.send({
						requestId: nextId(),
						to: `happy:${obligation.sessionId}`,
						body: text,
						replyTo: obligation.id,
					});
				}
			} catch {}
		}
	});

	pi.on("session_shutdown", () => {
		for (const socket of connections) socket.destroy();
		connections.clear();
		for (const settleWaiter of waiters.values()) settleWaiter("sirc: session shut down before a reply arrived.");
		waiters.clear();
		for (const [requestId, settleWaiter] of happyResultWaiters) {
			settleWaiter({
				type: "peer_send_result",
				requestId,
				ok: false,
				error: "session shut down before the bridge replied",
			});
		}
		happyResultWaiters.clear();
		clearInterval(happyPeerPoll);
		happyPeerPoll = undefined;
		server.close();
		cleanup();
	});

	function cleanup(): void {
		try {
			fs.rmSync(path.join(REGISTRY_DIR, `${process.pid}.json`), { force: true });
			fs.rmSync(path.join(REGISTRY_DIR, `${process.pid}.sock`), { force: true });
		} catch {}
	}

	process.once("exit", cleanup);

	async function sendToPeer(peer: Peer, frame: Frame, awaitReply: boolean): Promise<string> {
		return await new Promise<string>(resolve => {
			const socket = net.createConnection(peer.socket);
			let settled = false;
			const finish = (text: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiters.delete(frame.id);
				socket.destroy();
				resolve(text);
			};
			const timer = setTimeout(
				() => finish(`sirc: no reply from ${peerLabel(peer)} within ${Math.round(AWAIT_TIMEOUT_MS / 1000)}s.`),
				AWAIT_TIMEOUT_MS,
			);
			socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(`sirc: ${peerLabel(peer)} did not accept the connection.`));
			socket.on("error", error => finish(`sirc: ${peerLabel(peer)} unreachable (${error.message}).`));
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					try {
						handleLocalFrame(JSON.parse(line) as Frame, socket);
					} catch {}
				}
			});
			socket.on("connect", () => {
				socket.setTimeout(0);
				if (awaitReply) waiters.set(frame.id, finish);
				socket.write(`${JSON.stringify(frame)}\n`);
				if (!awaitReply) setTimeout(() => finish(`sent to ${peerLabel(peer)} (id ${frame.id})`), 25);
			});
		});
	}

	async function sendToHappyPeer(peer: HappyRosterPeer, frame: Frame, awaitReply: boolean): Promise<string> {
		const hook = attachHappyPeer();
		const handle = `happy:${peer.sessionId}`;
		if (!hook) return `sirc: ${handle} is unreachable because the Happy bridge is unavailable.`;
		const requestId = nextId();
		const result = await requestHappyResult(hook, requestId, "peer_send_result", () => {
			hook.send({
				requestId,
				to: handle,
				body: frame.body,
				...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
			});
		});
		if (result.type !== "peer_send_result" || result.ok !== true) {
			return `sirc: ${handle} delivery failed (${result.error ?? "unknown bridge error"}).`;
		}
		if (!awaitReply) {
			const id = typeof result.id === "string" ? result.id : requestId;
			return `sent to ${handle} (id ${id}, state=${result.delivered === false ? "queued" : "delivered"})`;
		}
		if (typeof result.id !== "string" || !result.id) {
			return `sirc: ${handle} delivery did not return a message id.`;
		}
		return await new Promise<string>(resolve => {
			let settled = false;
			const finish = (text: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiters.delete(result.id as string);
				resolve(text);
			};
			const timer = setTimeout(
				() => finish(`sirc: no reply from ${handle} within ${Math.round(AWAIT_TIMEOUT_MS / 1000)}s.`),
				AWAIT_TIMEOUT_MS,
			);
			waiters.set(result.id as string, finish);
		});
	}

	startHappyPeerDiscovery();
}

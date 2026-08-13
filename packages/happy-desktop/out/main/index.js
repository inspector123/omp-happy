import { BrowserWindow, app, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createStore } from "zustand/vanilla";
import sodium from "libsodium-wrappers";
import { homedir } from "node:os";
import { io } from "socket.io-client";
//#region src/sync/store.ts
/**
* Zustand vanilla store for the desktop sync core.
* Holds sessions + per-session messages and derives the DesktopState
* snapshot (sessions sorted by updatedAt desc, messages seq-asc) that the
* SyncEngine pushes over IPC after every change.
*/
function snapshotOf(state) {
	const sessions = Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
	const out = {
		status: state.status,
		sessions,
		messages: state.messages
	};
	if (state.error !== void 0) out.error = state.error;
	return out;
}
function insertSorted(list, message) {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = lo + hi >> 1;
		const current = list[mid];
		if (current.seq < message.seq || current.seq === message.seq && current.createdAt < message.createdAt || current.seq === message.seq && current.createdAt === message.createdAt && current.id < message.id) lo = mid + 1;
		else hi = mid;
	}
	list.splice(lo, 0, message);
}
function createDesktopStore() {
	const store = createStore()(() => ({
		status: "connecting",
		sessions: {},
		messages: {}
	}));
	return {
		getSnapshot: () => snapshotOf(store.getState()),
		subscribe: (listener) => store.subscribe((state) => listener(snapshotOf(state))),
		setStatus: (status) => {
			if (store.getState().status !== status) store.setState({ status });
		},
		setError: (error) => {
			if (store.getState().error !== error) store.setState({ error });
		},
		upsertSession: (session) => {
			const sessions = { ...store.getState().sessions };
			const existing = sessions[session.id];
			sessions[session.id] = existing ? {
				...existing,
				...session
			} : session;
			store.setState({ sessions });
		},
		upsertSessions: (sessions, opts) => {
			const current = store.getState().sessions;
			const next = opts?.prune ? {} : { ...current };
			for (const session of sessions) {
				const existing = current[session.id];
				next[session.id] = existing ? {
					...session,
					thinking: session.thinking || existing.thinking
				} : session;
			}
			store.setState({ sessions: next });
		},
		removeSession: (sessionId) => {
			const state = store.getState();
			if (!state.sessions[sessionId] && !state.messages[sessionId]) return;
			const sessions = { ...state.sessions };
			const messages = { ...state.messages };
			delete sessions[sessionId];
			delete messages[sessionId];
			store.setState({
				sessions,
				messages
			});
		},
		setSessionActivity: (sessionId, activity) => {
			const sessions = { ...store.getState().sessions };
			const existing = sessions[sessionId];
			if (existing) {
				if (existing.thinking === activity.thinking && existing.active === activity.active) return;
				sessions[sessionId] = {
					...existing,
					thinking: activity.thinking,
					active: activity.active
				};
			} else sessions[sessionId] = {
				id: sessionId,
				active: activity.active,
				thinking: activity.thinking,
				updatedAt: Date.now(),
				title: `session ${sessionId.slice(0, 6)}`,
				local: false,
				keyAvailable: false
			};
			store.setState({ sessions });
		},
		applyMessages: (sessionId, views) => {
			if (views.length === 0) return;
			const state = store.getState();
			const current = state.messages[sessionId] ?? [];
			const byId = new Map(current.map((m, i) => [m.id, i]));
			const next = [...current];
			let changed = false;
			for (const { view, stream, localId, toolResult } of views) {
				if (toolResult) {
					const scope = view.subagentId;
					const matchIdx = next.findIndex((m) => m.kind === "tool" && m.toolData?.callId === toolResult.callId && m.subagentId === scope);
					if (matchIdx !== -1) {
						const existing = next[matchIdx];
						next[matchIdx] = {
							...existing,
							toolData: {
								...existing.toolData,
								result: toolResult.result,
								error: toolResult.error
							}
						};
						changed = true;
					}
					continue;
				}
				if (localId) {
					const optimisticIndex = byId.get(`local:${localId}`);
					if (optimisticIndex !== void 0) {
						next.splice(optimisticIndex, 1);
						byId.delete(`local:${localId}`);
						byId.clear();
						next.forEach((m, i) => byId.set(m.id, i));
						changed = true;
					}
				}
				const existingIndex = byId.get(view.id);
				if (existingIndex !== void 0) {
					const existing = next[existingIndex];
					if (stream?.append) next[existingIndex] = {
						...view,
						text: existing.text + view.text,
						createdAt: existing.createdAt
					};
					else next[existingIndex] = view;
					changed = true;
					continue;
				}
				insertSorted(next, view);
				byId.clear();
				next.forEach((m, i) => byId.set(m.id, i));
				changed = true;
			}
			{
				const msgById = new Map(next.map((m) => [m.id, m]));
				const delegateMap = /* @__PURE__ */ new Map();
				for (const m of next) {
					if (m.kind !== "tool" || !m.toolData) continue;
					if (m.toolData.name !== "delegate_task") continue;
					const tasks = m.toolData.input?.tasks;
					if (!Array.isArray(tasks)) continue;
					for (const task of tasks) {
						if (!task || typeof task !== "object") continue;
						const t = task;
						const sa = typeof t.sessionSubagent === "string" ? t.sessionSubagent : void 0;
						if (sa) delegateMap.set(sa, m.id);
					}
				}
				function findParentForSubagent(subagentId, scopeChildren) {
					if (delegateMap.has(subagentId)) return delegateMap.get(subagentId) ?? null;
					for (const childId of scopeChildren) {
						const child = msgById.get(childId);
						if (!child || child.kind !== "tool" || !child.toolData) continue;
						if (child.toolData.name !== "delegate_task") continue;
						const tasks = child.toolData.input?.tasks;
						if (!Array.isArray(tasks)) continue;
						for (const task of tasks) {
							if (!task || typeof task !== "object") continue;
							const t = task;
							if ((typeof t.sessionSubagent === "string" ? t.sessionSubagent : void 0) === subagentId) return childId;
							const deeper = findParentForSubagent(subagentId, child.toolData.childMessageIds ?? []);
							if (deeper) return deeper;
						}
					}
					return null;
				}
				for (const m of next) if (m.toolData?.childMessageIds) m.toolData.childMessageIds = [];
				for (const m of next) {
					if (!m.subagentId) continue;
					const parentId = findParentForSubagent(m.subagentId, []);
					if (!parentId) continue;
					const parent = msgById.get(parentId);
					if (!parent?.toolData) continue;
					if (!parent.toolData.childMessageIds) parent.toolData.childMessageIds = [];
					if (!parent.toolData.childMessageIds.includes(m.id)) {
						parent.toolData.childMessageIds.push(m.id);
						changed = true;
					}
				}
			}
			if (changed || state.messages[sessionId] === void 0) store.setState({ messages: {
				...state.messages,
				[sessionId]: next
			} });
		},
		dropMessage: (sessionId, messageId) => {
			const state = store.getState();
			const current = state.messages[sessionId];
			if (!current) return;
			const next = current.filter((m) => m.id !== messageId);
			if (next.length !== current.length) store.setState({ messages: {
				...state.messages,
				[sessionId]: next
			} });
		}
	};
}
//#endregion
//#region src/sync/normalize.ts
function isRecord$3(value) {
	return typeof value === "object" && value !== null;
}
function asString(value) {
	return typeof value === "string" ? value : null;
}
function oneLine(text, max = 140) {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
/** Collapse a tool call to a one-line summary (name + the most salient input field). */
function summarizeToolCall(name, input) {
	if (!isRecord$3(input)) return name;
	const detail = asString(input.command) ?? asString(input.file_path) ?? asString(input.filePath) ?? asString(input.notebook_path) ?? asString(input.pattern) ?? asString(input.path) ?? asString(input.url) ?? asString(input.query) ?? asString(input.description) ?? asString(input.prompt);
	if (detail !== null) return `${name}: ${oneLine(detail)}`;
	try {
		return `${name}: ${oneLine(JSON.stringify(input))}`;
	} catch {
		return name;
	}
}
function view(base, id, role, kind, text, raw, createdAt, toolData, subagentId) {
	const out = {
		id,
		seq: base.seq,
		createdAt: createdAt ?? base.createdAt,
		role,
		kind,
		text,
		raw
	};
	if (toolData) out.toolData = toolData;
	if (subagentId) out.subagentId = subagentId;
	return out;
}
function push(out, v, stream, toolResult) {
	const entry = { view: v };
	if (stream) entry.stream = stream;
	if (toolResult) entry.toolResult = toolResult;
	out.push(entry);
}
/**
* Normalize one decrypted raw record into zero or more MessageViews.
* Returns an empty array for payloads that carry no renderable content
* (lifecycle events, tool results, malformed records).
*/
function normalizeDecryptedMessage(base, raw) {
	const out = [];
	if (!isRecord$3(raw)) return out;
	const role = raw.role;
	const content = raw.content;
	if (!isRecord$3(content)) return out;
	if (role === "user") {
		if (content.type === "text" && typeof content.text === "string") push(out, view(base, base.id, "user", "text", content.text, raw));
		return out;
	}
	if (role === "session") {
		normalizeSessionEnvelope(base, content, raw, out);
		return out;
	}
	if (role !== "agent") return out;
	const type = content.type;
	const data = content.data;
	if (type === "output" && isRecord$3(data)) {
		normalizeAgentOutput(base, data, raw, out);
		return out;
	}
	if ((type === "acp" || type === "codex") && isRecord$3(data)) {
		normalizeAcpLike(base, data, raw, out);
		return out;
	}
	if (type === "event") {
		push(out, view(base, base.id, "system", "event", eventSummary(data), raw));
		return out;
	}
	return out;
}
function eventSummary(data) {
	if (isRecord$3(data)) {
		const t = asString(data.type);
		if (t) return t;
	}
	try {
		return oneLine(JSON.stringify(data) ?? "event");
	} catch {
		return "event";
	}
}
function normalizeAgentOutput(base, data, raw, out) {
	const dataType = data.type;
	if (dataType === "assistant" && isRecord$3(data.message)) {
		const blocks = Array.isArray(data.message.content) ? data.message.content : [];
		let index = 0;
		for (const block of blocks) {
			if (!isRecord$3(block)) continue;
			const id = `${base.id}:${index}`;
			index += 1;
			if (block.type === "text" && typeof block.text === "string") push(out, view(base, id, "agent", "text", block.text, raw));
			else if (block.type === "thinking" && typeof block.thinking === "string") push(out, view(base, id, "agent", "thinking", block.thinking, raw));
			else if (block.type === "tool_use" || block.type === "tool-call") {
				const name = asString(block.name) ?? "unknown";
				const callId = asString(block.callId);
				const toolData = {
					name,
					input: block.input
				};
				if (callId) toolData.callId = callId;
				push(out, view(base, id, "agent", "tool", summarizeToolCall(name, block.input), raw, void 0, toolData));
			}
		}
		return;
	}
	if (dataType === "user" && isRecord$3(data.message)) {
		const content = data.message.content;
		if (typeof content === "string") {
			push(out, view(base, `${base.id}:0`, "user", "text", content, raw));
			return;
		}
		if (Array.isArray(content)) {
			const textParts = [];
			for (const block of content) if (isRecord$3(block) && block.type === "text" && typeof block.text === "string") textParts.push(block.text);
			if (textParts.length > 0) push(out, view(base, `${base.id}:0`, "user", "text", textParts.join("\n"), raw));
		}
		return;
	}
	if (dataType === "result") {
		const text = asString(data.result) ?? (data.is_error ? "error" : "result");
		push(out, view(base, base.id, "system", "event", text, raw));
		return;
	}
	if (dataType === "summary" && typeof data.summary === "string") {
		push(out, view(base, base.id, "system", "event", data.summary, raw));
		return;
	}
	if (dataType === "system") {
		push(out, view(base, base.id, "system", "event", "system", raw));
		return;
	}
}
function normalizeAcpLike(base, data, raw, out) {
	const dataType = data.type;
	if (dataType === "message" && typeof data.message === "string") {
		const streamId = asString(data.streamId);
		push(out, view(base, streamId ? `stream:${streamId}` : base.id, "agent", "text", data.message, raw), streamId ? {
			streamId,
			append: data.append === true
		} : void 0);
		return;
	}
	if (dataType === "thinking" && typeof data.text === "string") {
		const streamId = asString(data.streamId);
		push(out, view(base, streamId ? `stream:${streamId}` : base.id, "agent", "thinking", data.text, raw), streamId ? {
			streamId,
			append: data.append === true
		} : void 0);
		return;
	}
	if (dataType === "reasoning" && typeof data.message === "string") {
		push(out, view(base, base.id, "agent", "thinking", data.message, raw));
		return;
	}
	if (dataType === "tool-call") {
		const name = asString(data.name) ?? "unknown";
		const callId = asString(data.callId);
		const toolData = {
			name,
			input: data.input
		};
		if (callId) toolData.callId = callId;
		push(out, view(base, base.id, "agent", "tool", summarizeToolCall(name, data.input), raw, void 0, toolData));
		return;
	}
	if (dataType === "tool-result" || dataType === "tool-call-result") {
		const callId = asString(data.callId);
		if (!callId) return;
		const isError = data.is_error === true || data.error === true;
		push(out, view(base, base.id, "agent", "tool", "", raw), void 0, {
			callId,
			result: data.output ?? data,
			error: isError
		});
		return;
	}
	if (dataType === "file-edit") {
		const name = asString(data.filePath) ?? asString(data.description) ?? "file";
		push(out, view(base, base.id, "agent", "tool", `Edit: ${oneLine(name)}`, raw));
		return;
	}
}
function normalizeSessionEnvelope(base, content, raw, out) {
	const envelope = content.type === "session" && isRecord$3(content.data) ? content.data : content;
	const ev = isRecord$3(envelope.ev) ? envelope.ev : null;
	const id = asString(envelope.id) ?? base.id;
	const time = typeof envelope.time === "number" ? envelope.time : base.createdAt;
	const subagentId = asString(envelope.subagent) ?? void 0;
	if (!ev) return;
	if (ev.t === "text" && typeof ev.text === "string") {
		if (envelope.role === "user") push(out, view(base, id, "user", "text", ev.text, raw, time, void 0, subagentId));
		else if (envelope.role === "agent") push(out, view(base, id, "agent", ev.thinking === true ? "thinking" : "text", ev.text, raw, time, void 0, subagentId));
		return;
	}
	if (ev.t === "service" && typeof ev.text === "string" && envelope.role === "agent") {
		push(out, view(base, id, "agent", "text", ev.text, raw, time, void 0, subagentId));
		return;
	}
	if (ev.t === "tool-call-start") {
		const name = asString(ev.name) ?? "unknown";
		const callId = asString(ev.call);
		const toolData = {
			name,
			input: ev.args
		};
		if (callId) toolData.callId = callId;
		push(out, view(base, id, "agent", "tool", summarizeToolCall(name, ev.args), raw, time, toolData, subagentId));
		return;
	}
	if (ev.t === "tool-call-end" || ev.t === "tool-call-result") {
		const callId = asString(ev.call);
		if (!callId) return;
		const isError = ev.is_error === true || ev.error === true;
		push(out, view(base, id, "agent", "tool", "", raw, time, void 0, subagentId), void 0, {
			callId,
			result: ev.output ?? ev,
			error: isError
		});
		return;
	}
	if (ev.t === "turn-end" && subagentId) {
		push(out, view(base, id, "system", "event", "", raw, time, {
			name: "__lifecycle__",
			input: { status: ev.status === "failed" ? "failed" : ev.status === "cancelled" ? "aborted" : "completed" }
		}, subagentId));
		return;
	}
	if (ev.t === "start" && subagentId) {
		push(out, view(base, `${subagentId}:start`, "system", "event", "", raw, time, {
			name: "__lifecycle__",
			input: { status: "running" }
		}, subagentId));
		return;
	}
	if (ev.t === "stop" && subagentId) {
		const isError = ev.exit_code !== void 0 && ev.exit_code !== 0 || ev.error === true;
		push(out, view(base, `${subagentId}:stop`, "system", "event", "", raw, time, {
			name: "__lifecycle__",
			input: { status: isError ? "failed" : "completed" }
		}, subagentId));
		return;
	}
}
//#endregion
//#region src/sync/encryption.ts
/**
* Message encryption for the happy-desktop sync core.
*
* Message algorithms and wire formats are ported from
* packages/happy-cli/src/api/encryption.ts. The legacy NaCl secretbox path
* uses libsodium-wrappers instead of tweetnacl; both implement compatible
* XSalsa20-Poly1305 ciphertext. Account content-key derivation and wrapped-key
* opening match packages/happy-app and packages/happy-agent.
*
* dataKey variant: AES-256-GCM via node:crypto, bundle layout
* [version=0 (1)] [nonce (12)] [ciphertext] [auth tag (16)].
*/
var sodiumReady = null;
function ensureSodium() {
	if (!sodiumReady) sodiumReady = sodium.ready.then(() => void 0);
	return sodiumReady;
}
function encodeBase64(buffer, variant = "base64") {
	if (variant === "base64url") return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return Buffer.from(buffer).toString("base64");
}
function decodeBase64(base64, variant = "base64") {
	if (variant === "base64url") {
		const base64Standard = base64.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - base64.length % 4) % 4);
		return new Uint8Array(Buffer.from(base64Standard, "base64"));
	}
	return new Uint8Array(Buffer.from(base64, "base64"));
}
function getRandomBytes(size) {
	return new Uint8Array(randomBytes(size));
}
/**
* Derive the account content-box private key used by Happy app/agent.
*
* This is the private counterpart to access.key's content publicKey:
* deriveKey(accountSecret, 'Happy EnCoder', ['content']) followed by
* libsodium's deterministic crypto_box seed keypair.
*/
async function deriveContentSecretKey(accountSecret) {
	const encoder = new TextEncoder();
	let derived = new Uint8Array(createHmac("sha512", encoder.encode("Happy EnCoder Master Seed")).update(accountSecret).digest());
	const childName = encoder.encode("content");
	const childData = new Uint8Array(childName.length + 1);
	childData.set(childName, 1);
	derived = new Uint8Array(createHmac("sha512", derived.subarray(32)).update(childData).digest());
	await ensureSodium();
	return new Uint8Array(sodium.crypto_box_seed_keypair(derived.subarray(0, 32)).privateKey);
}
/**
* Open a server record's wrapped dataEncryptionKey.
*
* Wire format: version(0) + ephemeral public key(32) + nonce(24) +
* NaCl box ciphertext(32-byte data key + 16-byte MAC). Invalid, foreign, or
* unsupported bundles return null so one inaccessible record cannot fail sync.
*/
async function unwrapDataEncryptionKey(encoded, contentSecretKey) {
	try {
		await ensureSodium();
		const wrapped = decodeBase64(encoded);
		const publicKeyBytes = sodium.crypto_box_PUBLICKEYBYTES;
		const nonceBytes = sodium.crypto_box_NONCEBYTES;
		const macBytes = sodium.crypto_box_MACBYTES;
		const dataKeyBytes = 32;
		const expectedBytes = 1 + publicKeyBytes + nonceBytes + dataKeyBytes + macBytes;
		if (wrapped.length !== expectedBytes || wrapped[0] !== 0 || contentSecretKey.length !== sodium.crypto_box_SECRETKEYBYTES) return null;
		const bundleOffset = 1;
		const nonceOffset = bundleOffset + publicKeyBytes;
		const ciphertextOffset = nonceOffset + nonceBytes;
		const decrypted = sodium.crypto_box_open_easy(wrapped.subarray(ciphertextOffset), wrapped.subarray(nonceOffset, ciphertextOffset), wrapped.subarray(bundleOffset, nonceOffset), contentSecretKey);
		return decrypted.length === dataKeyBytes ? new Uint8Array(decrypted) : null;
	} catch {
		return null;
	}
}
/**
* Encrypt data using the secret key (NaCl secretbox, XSalsa20-Poly1305).
* Wire format: [nonce (24 bytes)] [encrypted data]
*/
async function encryptLegacy(data, secret) {
	await ensureSodium();
	const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
	const plaintext = new TextEncoder().encode(JSON.stringify(data));
	const encrypted = sodium.crypto_secretbox_easy(plaintext, nonce, secret);
	const result = new Uint8Array(nonce.length + encrypted.length);
	result.set(nonce);
	result.set(encrypted, nonce.length);
	return result;
}
/**
* Decrypt data using the secret key. Returns null on failure.
*/
async function decryptLegacy(data, secret) {
	await ensureSodium();
	if (data.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) return null;
	const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
	const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);
	try {
		const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
		return JSON.parse(new TextDecoder().decode(decrypted));
	} catch {
		return null;
	}
}
/**
* Encrypt data using AES-256-GCM with the data encryption key.
* Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
*/
async function encryptWithDataKey(data, dataKey) {
	const nonce = getRandomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
	const plaintext = new TextEncoder().encode(JSON.stringify(data));
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const authTag = cipher.getAuthTag();
	const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
	bundle.set([0], 0);
	bundle.set(nonce, 1);
	bundle.set(new Uint8Array(encrypted), 13);
	bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
	return bundle;
}
/**
* Decrypt data using AES-256-GCM with the data encryption key.
* Returns null on failure.
*/
async function decryptWithDataKey(bundle, dataKey) {
	if (bundle.length < 1) return null;
	if (bundle[0] !== 0) return null;
	if (bundle.length < 29) return null;
	const nonce = bundle.slice(1, 13);
	const authTag = bundle.slice(bundle.length - 16);
	const ciphertext = bundle.slice(13, bundle.length - 16);
	try {
		const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
		decipher.setAuthTag(authTag);
		const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		return JSON.parse(new TextDecoder().decode(decrypted));
	} catch {
		return null;
	}
}
async function encrypt(key, variant, data) {
	if (variant === "legacy") return encryptLegacy(data, key);
	return encryptWithDataKey(data, key);
}
async function decrypt(key, variant, data) {
	if (variant === "legacy") return decryptLegacy(data, key);
	return decryptWithDataKey(data, key);
}
//#endregion
//#region src/sync/daemonClient.ts
/**
* Client for the local Happy daemon's control server + persisted state.
*
* Key resolution for sessions (contract): (1) POST /list on the daemon's
* localhost control server — newer daemons attach
* `encryption: { key /* base64 *\/, variant }` per child — (2) fall back to
* the persisted `$HAPPY_HOME_DIR/sessions.json` (the RUNNING daemon may be
* old code without the encryption field). Both sources are merged; /list
* wins. Port comes from `$HAPPY_HOME_DIR/daemon.state.json` (httpPort).
*/
/** Mirrors readPersistedSessions in happy-cli: entries older than this are dropped. */
var PERSISTED_SESSION_MAX_AGE_MS = 336 * 3600 * 1e3;
function isRecord$2(value) {
	return typeof value === "object" && value !== null;
}
function readVariant(value) {
	return value === "legacy" || value === "dataKey" ? value : null;
}
/** Read the daemon control-server port from daemon.state.json; null when absent/malformed. */
async function readDaemonPort$1(homeDir) {
	try {
		const parsed = JSON.parse(await readFile(join(homeDir, "daemon.state.json"), "utf8"));
		if (isRecord$2(parsed) && typeof parsed.httpPort === "number" && parsed.httpPort > 0) return parsed.httpPort;
		return null;
	} catch {
		return null;
	}
}
/**
* POST /list on the daemon control server.
* Tolerates older daemons (no encryption field) and any failure → [].
*/
async function listDaemonSessions(port) {
	let body;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/list`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(5e3)
		});
		if (!response.ok) return [];
		body = await response.json();
	} catch {
		return [];
	}
	if (!isRecord$2(body) || !Array.isArray(body.children)) return [];
	const children = [];
	for (const child of body.children) {
		if (!isRecord$2(child) || typeof child.happySessionId !== "string" || typeof child.pid !== "number") continue;
		const info = {
			sessionId: child.happySessionId,
			pid: child.pid,
			startedBy: typeof child.startedBy === "string" ? child.startedBy : "unknown"
		};
		if (typeof child.agent === "string") info.agent = child.agent;
		if (typeof child.path === "string") info.path = child.path;
		const variant = isRecord$2(child.encryption) ? readVariant(child.encryption.variant) : null;
		if (isRecord$2(child.encryption) && typeof child.encryption.key === "string" && variant !== null) info.encryption = {
			key: child.encryption.key,
			variant
		};
		children.push(info);
	}
	return children;
}
/**
* Parse `$HAPPY_HOME_DIR/sessions.json`:
* { sessions: { <id>: { encryptionKey, encryptionVariant, ..., savedAt } } }.
* Entries older than 14 days (by savedAt) are dropped, mirroring the CLI's
* readPersistedSessions. Missing file / malformed entries are tolerated.
*/
async function readPersistedSessionKeys(homeDir, now = Date.now()) {
	const keys = /* @__PURE__ */ new Map();
	let parsed;
	try {
		parsed = JSON.parse(await readFile(join(homeDir, "sessions.json"), "utf8"));
	} catch {
		return keys;
	}
	if (!isRecord$2(parsed) || !isRecord$2(parsed.sessions)) return keys;
	for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
		if (!isRecord$2(entry) || typeof entry.encryptionKey !== "string" || entry.encryptionKey.length === 0) continue;
		const variant = readVariant(entry.encryptionVariant);
		if (variant === null) continue;
		if (typeof entry.savedAt === "number" && now - entry.savedAt > PERSISTED_SESSION_MAX_AGE_MS) continue;
		keys.set(sessionId, {
			sessionId,
			encryptionKey: entry.encryptionKey,
			encryptionVariant: variant
		});
	}
	return keys;
}
/**
* Merge key sources: daemon /list encryption (preferred) over sessions.json.
* Never throws — a missing/unreachable/old daemon just yields the file fallback.
*/
async function resolveSessionKeys(homeDir, port, now = Date.now()) {
	const [persisted, children] = await Promise.all([readPersistedSessionKeys(homeDir, now), port !== null ? listDaemonSessions(port) : Promise.resolve([])]);
	const keys = new Map(persisted);
	const local = /* @__PURE__ */ new Set();
	for (const child of children) {
		local.add(child.sessionId);
		if (child.encryption) keys.set(child.sessionId, {
			sessionId: child.sessionId,
			encryptionKey: child.encryption.key,
			encryptionVariant: child.encryption.variant
		});
	}
	return {
		keys,
		local,
		children
	};
}
//#endregion
//#region src/sync/credentials.ts
/**
* Reads the local Happy CLI credentials ($HAPPY_HOME_DIR/access.key,
* default ~/.omp-happy) and the optional Happy Agent account credential
* ($HAPPY_HOME_DIR/agent.key). These are the same files parsed by Happy CLI's
* persistence and resume credential loaders. Key material stays in sync core.
*/
function defaultHappyHomeDir() {
	return process.env.HAPPY_HOME_DIR || join(homedir(), ".omp-happy");
}
function decode(value, name) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`access.key: ${name} is missing or not a string`);
	return new Uint8Array(Buffer.from(value, "base64"));
}
/** Load full credentials (token + encryption material) from access.key. */
async function loadCredentials$1(homeDir = defaultHappyHomeDir()) {
	const file = join(homeDir, "access.key");
	let parsed;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read credentials from ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed.token !== "string" || parsed.token.length === 0) throw new Error(`access.key at ${file} has no token`);
	let encryption;
	if (typeof parsed.secret === "string" && parsed.secret.length > 0) encryption = {
		type: "legacy",
		secret: decode(parsed.secret, "secret")
	};
	else if (parsed.encryption && typeof parsed.encryption === "object") {
		const enc = parsed.encryption;
		encryption = {
			type: "dataKey",
			publicKey: decode(enc.publicKey, "encryption.publicKey"),
			machineKey: decode(enc.machineKey, "encryption.machineKey")
		};
	} else throw new Error(`access.key at ${file} has neither secret nor encryption material`);
	return {
		token: parsed.token,
		homeDir,
		encryption
	};
}
/**
* Read the account master secret stored by Happy Agent authentication.
*
* Modern access.key credentials intentionally contain only the content public
* key, so agent.key is the co-located source capable of opening server-wrapped
* per-session keys. Missing and malformed files are expected and nonfatal.
*/
async function loadAccountSecret(homeDir = defaultHappyHomeDir()) {
	try {
		const value = JSON.parse(await readFile(join(homeDir, "agent.key"), "utf8"));
		if (!value || typeof value !== "object") return null;
		const parsed = value;
		if (typeof parsed.token !== "string" || parsed.token.length === 0 || typeof parsed.secret !== "string" || parsed.secret.length === 0) return null;
		const secret = new Uint8Array(Buffer.from(parsed.secret, "base64"));
		return secret.length === 32 ? secret : null;
	} catch {
		return null;
	}
}
/** The machine RPC key: machineKey (dataKey creds) or master secret (legacy creds). */
function machineRpcKey(credentials) {
	return credentials.encryption.type === "dataKey" ? {
		key: credentials.encryption.machineKey,
		variant: "dataKey"
	} : {
		key: credentials.encryption.secret,
		variant: "legacy"
	};
}
//#endregion
//#region src/sync/serverClient.ts
/**
* Server client for the desktop sync core: user-scoped REST (fetch) plus the
* socket.io /v1/updates channel. Mirrors happy-app's apiSocket.ts
* (user-scoped connect, rpc-call encryption for machineRPC) and the REST
* calls in sync.ts (fetchSessions / fetchMessages v3 / outbox POST).
*/
function isRecord$1(value) {
	return typeof value === "object" && value !== null;
}
function parseMessage(value) {
	if (!isRecord$1(value) || typeof value.id !== "string" || typeof value.seq !== "number") return null;
	if (!isRecord$1(value.content) || value.content.t !== "encrypted" || typeof value.content.c !== "string") return null;
	return {
		id: value.id,
		seq: value.seq,
		content: {
			t: "encrypted",
			c: value.content.c
		},
		localId: typeof value.localId === "string" ? value.localId : null,
		createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
	};
}
var ServerClient = class {
	serverUrl;
	token;
	happyClient;
	socket = null;
	updateHandlers = /* @__PURE__ */ new Set();
	ephemeralHandlers = /* @__PURE__ */ new Set();
	statusHandlers = /* @__PURE__ */ new Set();
	status = "offline";
	constructor(opts) {
		this.serverUrl = opts.serverUrl.replace(/\/$/, "");
		this.token = opts.token;
		this.happyClient = opts.happyClient ?? "happy-desktop/0.0.1";
	}
	headers() {
		return {
			"Authorization": `Bearer ${this.token}`,
			"Content-Type": "application/json",
			"X-Happy-Client": this.happyClient
		};
	}
	async listSessions() {
		const response = await fetch(`${this.serverUrl}/v1/sessions`, { headers: this.headers() });
		if (!response.ok) throw new Error(`Failed to fetch sessions: ${response.status}`);
		const body = await response.json();
		if (!isRecord$1(body) || !Array.isArray(body.sessions)) return [];
		const sessions = [];
		for (const value of body.sessions) {
			if (!isRecord$1(value) || typeof value.id !== "string") continue;
			sessions.push({
				id: value.id,
				tag: typeof value.tag === "string" ? value.tag : null,
				seq: typeof value.seq === "number" ? value.seq : 0,
				metadata: typeof value.metadata === "string" ? value.metadata : "",
				metadataVersion: typeof value.metadataVersion === "number" ? value.metadataVersion : 0,
				agentState: typeof value.agentState === "string" ? value.agentState : null,
				agentStateVersion: typeof value.agentStateVersion === "number" ? value.agentStateVersion : 0,
				dataEncryptionKey: typeof value.dataEncryptionKey === "string" ? value.dataEncryptionKey : null,
				active: value.active === true,
				activeAt: typeof value.activeAt === "number" ? value.activeAt : 0,
				createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
				updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
				lastMessage: parseMessage(value.lastMessage)
			});
		}
		return sessions;
	}
	async getMessages(sessionId, opts) {
		const params = new URLSearchParams();
		if (opts.afterSeq !== void 0) params.set("after_seq", String(opts.afterSeq));
		if (opts.beforeSeq !== void 0) params.set("before_seq", String(opts.beforeSeq));
		params.set("limit", String(opts.limit ?? 100));
		const response = await fetch(`${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages?${params}`, { headers: this.headers() });
		if (!response.ok) throw new Error(`Failed to fetch messages for ${sessionId}: ${response.status}`);
		const body = await response.json();
		const messages = [];
		if (isRecord$1(body) && Array.isArray(body.messages)) for (const value of body.messages) {
			const parsed = parseMessage(value);
			if (parsed) messages.push(parsed);
		}
		return {
			messages,
			hasMore: isRecord$1(body) && body.hasMore === true
		};
	}
	async postMessages(sessionId, messages) {
		const response = await fetch(`${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ messages })
		});
		if (!response.ok) throw new Error(`Failed to send messages for ${sessionId}: ${response.status}`);
		const body = await response.json();
		const posted = [];
		if (isRecord$1(body) && Array.isArray(body.messages)) {
			for (const value of body.messages) if (isRecord$1(value) && typeof value.id === "string" && typeof value.seq === "number") posted.push({
				id: value.id,
				seq: value.seq,
				localId: typeof value.localId === "string" ? value.localId : null,
				createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
				updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
			});
		}
		return posted;
	}
	onUpdate(handler) {
		this.updateHandlers.add(handler);
		return () => this.updateHandlers.delete(handler);
	}
	onEphemeral(handler) {
		this.ephemeralHandlers.add(handler);
		return () => this.ephemeralHandlers.delete(handler);
	}
	onStatus(handler) {
		this.statusHandlers.add(handler);
		return () => this.statusHandlers.delete(handler);
	}
	setStatus(status) {
		if (this.status !== status) {
			this.status = status;
			for (const handler of this.statusHandlers) handler(status);
		}
	}
	connect() {
		if (this.socket) return;
		this.setStatus("connecting");
		this.socket = io(this.serverUrl, {
			path: "/v1/updates",
			auth: {
				token: this.token,
				clientType: "user-scoped",
				happyClient: this.happyClient
			},
			transports: ["websocket"],
			reconnection: true,
			reconnectionDelay: 1e3,
			reconnectionDelayMax: 5e3,
			reconnectionAttempts: Infinity
		});
		this.socket.on("connect", () => this.setStatus("online"));
		this.socket.on("disconnect", () => this.setStatus("offline"));
		this.socket.on("connect_error", () => this.setStatus("offline"));
		this.socket.on("update", (data) => {
			for (const handler of this.updateHandlers) handler(data);
		});
		this.socket.on("ephemeral", (data) => {
			for (const handler of this.ephemeralHandlers) handler(data);
		});
	}
	async disconnect() {
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.removeAllListeners();
			socket.disconnect();
		}
		this.setStatus("offline");
	}
	/**
	* sessionRPC: params and results are encrypted with the session-specific key.
	* This is the same rpc-call transport used by happy-app's apiSocket.sessionRPC.
	*/
	async sessionRPC(sessionId, method, params, key, variant) {
		if (!this.socket) throw new Error("Socket not connected");
		const encryptedParams = encodeBase64(await encrypt(key, variant, params));
		const result = await this.socket.timeout(3e4).emitWithAck("rpc-call", {
			method: `${sessionId}:${method}`,
			params: encryptedParams
		});
		if (isRecord$1(result) && result.ok === true && typeof result.result === "string") return await decrypt(key, variant, decodeBase64(result.result));
		const message = isRecord$1(result) && typeof result.error === "string" ? result.error : "RPC call failed";
		throw new Error(message);
	}
	/**
	* machineRPC: params encrypted with the machine's encryption key exactly as
	* happy-app's apiSocket.machineRPC does — the daemon's RpcHandlerManager
	* decrypts with the same key (access.key machineKey for dataKey creds).
	*/
	async machineRPC(machineId, method, params, key, variant) {
		if (!this.socket) throw new Error("Socket not connected");
		const encryptedParams = encodeBase64(await encrypt(key, variant, params));
		const result = await this.socket.timeout(3e4).emitWithAck("rpc-call", {
			method: `${machineId}:${method}`,
			params: encryptedParams
		});
		if (isRecord$1(result) && result.ok === true && typeof result.result === "string") return await decrypt(key, variant, decodeBase64(result.result));
		const message = isRecord$1(result) && typeof result.error === "string" ? result.error : "RPC call failed";
		throw new Error(message);
	}
};
//#endregion
//#region src/sync/syncEngine.ts
/**
* SyncEngine — orchestrates session fetch, live socket updates, message
* decrypt/normalize, and the outbox. Pure Node (no electron imports); the
* Electron main process drives it and forwards 'state' events over IPC.
*
* Ported behavior:
* - fetchSessions / fetchMessages v3 paging / outbox POST / socket update
*   handling: packages/happy-app/sources/sync/sync.ts
* - user-scoped socket + machineRPC encryption: happy-app apiSocket.ts
* - key resolution: daemon /list + sessions.json first, then client-side
*   recovery from server-wrapped keys using the co-located agent credential
*/
/** Mirrors SEQ_BACKWARD_INITIAL_SENTINEL in happy-app sync.ts (int4 max). */
var SEQ_BACKWARD_INITIAL_SENTINEL = 2147483647;
var MESSAGES_PAGE_LIMIT = 100;
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function truncate(text, max = 80) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
var SyncEngine = class extends EventEmitter {
	serverUrl;
	credentials;
	daemonPortOption;
	store;
	server;
	keys = /* @__PURE__ */ new Map();
	localIds = /* @__PURE__ */ new Set();
	lastSeq = /* @__PURE__ */ new Map();
	openSessions = /* @__PURE__ */ new Set();
	unsubscribers = [];
	refreshPromise = null;
	refreshQueued = false;
	pollTimer = null;
	started = false;
	constructor(opts) {
		super();
		this.serverUrl = opts.serverUrl;
		this.credentials = opts.credentials;
		this.daemonPortOption = opts.daemon?.port;
		this.store = createDesktopStore();
		this.server = new ServerClient({
			serverUrl: opts.serverUrl,
			token: opts.credentials.token
		});
		this.store.subscribe((snapshot) => this.emit("state", snapshot));
	}
	getState() {
		return this.store.getSnapshot();
	}
	async start() {
		if (this.started) return;
		this.started = true;
		this.store.setStatus("connecting");
		this.unsubscribers.push(this.server.onUpdate((update) => {
			this.handleUpdate(update).catch((error) => {
				this.store.setError(error instanceof Error ? error.message : String(error));
			});
		}));
		this.unsubscribers.push(this.server.onEphemeral((update) => this.handleEphemeral(update)));
		this.unsubscribers.push(this.server.onStatus((status) => {
			this.store.setStatus(status);
			if (status === "online") this.refreshSessions().then(() => Promise.all([...this.openSessions].map((id) => this.forwardSync(id)))).catch((error) => {
				this.store.setError(error instanceof Error ? error.message : String(error));
			});
		}));
		this.server.connect();
		this.pollTimer = setInterval(() => {
			this.refreshSessions().catch(() => void 0);
		}, 3e4);
		try {
			await this.refreshSessions();
		} catch (error) {
			this.store.setError(error instanceof Error ? error.message : String(error));
		}
	}
	async stop() {
		this.started = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		await this.server.disconnect();
		this.store.setStatus("offline");
	}
	/** Ensure messages for a session are fetched and kept up to date. */
	async openSession(sessionId) {
		this.openSessions.add(sessionId);
		if (!this.keys.has(sessionId)) {
			for (let attempt = 0; attempt < 6 && !this.keys.has(sessionId); attempt++) {
				await this.resolveKeys();
				if (!this.keys.has(sessionId)) {
					const { promise, resolve } = Promise.withResolvers();
					setTimeout(resolve, 500);
					await promise;
				}
			}
			if (this.keys.has(sessionId)) await this.refreshSessions();
		}
		await this.initialFetch(sessionId);
	}
	async sendMessage(sessionId, text) {
		const keyInfo = this.keys.get(sessionId);
		if (!keyInfo) throw new Error(`No encryption key available for session ${sessionId}`);
		const localId = randomUUID();
		const raw = {
			role: "user",
			content: {
				type: "text",
				text
			},
			meta: { sentFrom: "web" }
		};
		const content = encodeBase64(await encrypt(keyInfo.key, keyInfo.variant, raw));
		const seq = (this.lastSeq.get(sessionId) ?? 0) + 1;
		const optimistic = { view: {
			id: `local:${localId}`,
			seq,
			createdAt: Date.now(),
			role: "user",
			kind: "text",
			text,
			raw
		} };
		this.store.applyMessages(sessionId, [optimistic]);
		try {
			const posted = await this.server.postMessages(sessionId, [{
				localId,
				content
			}]);
			let maxSeq = this.lastSeq.get(sessionId) ?? 0;
			for (const message of posted) if (message.seq > maxSeq) maxSeq = message.seq;
			this.lastSeq.set(sessionId, maxSeq);
		} catch (error) {
			this.store.dropMessage(sessionId, `local:${localId}`);
			throw error;
		}
	}
	/**
	* Spawn a session on a machine via machineRPC ('spawn-happy-session' with
	* type 'spawn-in-directory'), params encrypted with the machine key from
	* access.key — the encryption pattern of happy-app apiSocket.machineRPC.
	*/
	async spawnSession(machineId, directory, agent) {
		const { key, variant } = machineRpcKey(await loadCredentials$1(this.credentials.homeDir));
		const result = await this.server.machineRPC(machineId, "spawn-happy-session", {
			type: "spawn-in-directory",
			directory,
			agent
		}, key, variant);
		this.refreshSessions().catch(() => void 0);
		if (isRecord(result) && result.type === "success" && typeof result.sessionId === "string") {
			const spawnedId = result.sessionId;
			(async () => {
				for (let attempt = 0; attempt < 45 && this.started; attempt++) {
					await this.refreshSessions();
					if (this.getState().sessions.find((s) => s.id === spawnedId)?.keyAvailable) return;
					const { promise: delay, resolve: releaseDelay } = Promise.withResolvers();
					setTimeout(releaseDelay, 2e3);
					await delay;
				}
			})().catch(() => void 0);
			return {
				type: "success",
				sessionId: spawnedId
			};
		}
		if (isRecord(result)) {
			if (result.type === "requestToApproveDirectoryCreation" && typeof result.directory === "string") return {
				type: "requestToApproveDirectoryCreation",
				directory: result.directory
			};
			if (typeof result.error === "string") return {
				type: "error",
				errorMessage: result.error
			};
			if (typeof result.errorMessage === "string") return {
				type: "error",
				errorMessage: result.errorMessage
			};
		}
		return {
			type: "error",
			errorMessage: "Unexpected spawn result"
		};
	}
	/**
	* Stop an active session through its encrypted session RPC channel.
	* This deliberately does not use the localhost daemon stop endpoint: remote
	* sessions must travel through the server-backed killSession handler.
	*/
	async killSession(sessionId) {
		const session = this.getState().sessions.find((candidate) => candidate.id === sessionId);
		if (!session) throw new Error(`Unknown session ${sessionId}`);
		if (!session.active) throw new Error("Session is already stopped");
		const keyInfo = this.keys.get(sessionId);
		if (!keyInfo) throw new Error(`No encryption key available for session ${sessionId}`);
		const result = await this.server.sessionRPC(sessionId, "killSession", {}, keyInfo.key, keyInfo.variant);
		if (!isRecord(result) || typeof result.success !== "boolean") throw new Error("Unexpected stop-session response");
		const message = typeof result.message === "string" ? result.message : result.success ? "Session stopped" : "Session could not be stopped";
		if (result.success) this.refreshSessions().catch(() => void 0);
		return {
			success: result.success,
			message
		};
	}
	async resolveKeys() {
		const port = this.daemonPortOption ?? await readDaemonPort$1(this.credentials.homeDir);
		const resolved = await resolveSessionKeys(this.credentials.homeDir, port);
		const localKeys = new Map([...resolved.keys.entries()].map(([id, info]) => [id, {
			key: decodeBase64(info.encryptionKey),
			variant: info.encryptionVariant
		}]));
		for (const [id, key] of localKeys) this.keys.set(id, key);
		this.localIds = resolved.local;
		return localKeys;
	}
	async recoverServerKeys(records, target) {
		if (!records.some((record) => !target.has(record.id) && record.dataEncryptionKey)) return;
		const accountSecret = await loadAccountSecret(this.credentials.homeDir);
		if (!accountSecret) return;
		let contentSecretKey = null;
		try {
			contentSecretKey = await deriveContentSecretKey(accountSecret);
			for (const record of records) {
				if (target.has(record.id) || !record.dataEncryptionKey) continue;
				const key = await unwrapDataEncryptionKey(record.dataEncryptionKey, contentSecretKey);
				if (key) target.set(record.id, {
					key,
					variant: "dataKey"
				});
			}
		} catch {} finally {
			accountSecret.fill(0);
			contentSecretKey?.fill(0);
		}
	}
	refreshSessions() {
		if (this.refreshPromise) {
			this.refreshQueued = true;
			return this.refreshPromise;
		}
		this.refreshPromise = (async () => {
			try {
				do {
					this.refreshQueued = false;
					const localKeys = await this.resolveKeys();
					const records = await this.server.listSessions();
					await this.recoverServerKeys(records, localKeys);
					this.keys = localKeys;
					const views = [];
					for (const record of records) views.push(await this.buildSessionView(record));
					this.store.upsertSessions(views, { prune: true });
				} while (this.refreshQueued);
			} finally {
				this.refreshPromise = null;
			}
		})();
		return this.refreshPromise;
	}
	async decryptFor(sessionId, encrypted) {
		const keyInfo = this.keys.get(sessionId);
		if (!keyInfo) return null;
		return decrypt(keyInfo.key, keyInfo.variant, decodeBase64(encrypted));
	}
	async buildSessionView(record) {
		const keyAvailable = this.keys.has(record.id);
		let title = null;
		let path;
		let agent;
		let machineId;
		if (keyAvailable) {
			const metadata = record.metadata ? await this.decryptFor(record.id, record.metadata) : null;
			if (isRecord(metadata)) {
				if (isRecord(metadata.summary) && typeof metadata.summary.text === "string" && metadata.summary.text.length > 0) title = metadata.summary.text;
				if (typeof metadata.path === "string") path = metadata.path;
				if (typeof metadata.flavor === "string") agent = metadata.flavor;
				if (typeof metadata.machineId === "string") machineId = metadata.machineId;
			}
			if (!title && record.lastMessage) {
				const lastRaw = await this.decryptFor(record.id, record.lastMessage.content.c);
				const firstUserText = normalizeDecryptedMessage({
					id: record.lastMessage.id,
					localId: record.lastMessage.localId,
					createdAt: record.lastMessage.createdAt,
					seq: record.lastMessage.seq
				}, lastRaw).find((v) => v.view.role === "user" && v.view.kind === "text");
				if (firstUserText) title = truncate(firstUserText.view.text);
			}
		}
		const view = {
			id: record.id,
			active: record.active,
			thinking: false,
			updatedAt: record.updatedAt,
			title: title ?? `session ${record.id.slice(0, 6)}`,
			local: this.localIds.has(record.id),
			keyAvailable
		};
		if (path !== void 0) view.path = path;
		if (agent !== void 0) view.agent = agent;
		if (machineId !== void 0) view.machineId = machineId;
		return view;
	}
	async decryptMessages(sessionId, messages) {
		const ordered = [...messages].sort((a, b) => a.seq - b.seq);
		const out = [];
		for (const message of ordered) {
			const raw = await this.decryptFor(sessionId, message.content.c);
			if (raw === null) continue;
			const views = normalizeDecryptedMessage({
				id: message.id,
				localId: message.localId,
				createdAt: message.createdAt,
				seq: message.seq
			}, raw);
			for (const view of views) {
				view.localId = message.localId;
				out.push(view);
			}
		}
		return out;
	}
	async initialFetch(sessionId) {
		if (!this.keys.has(sessionId)) return;
		const page = await this.server.getMessages(sessionId, {
			beforeSeq: SEQ_BACKWARD_INITIAL_SENTINEL,
			limit: MESSAGES_PAGE_LIMIT
		});
		const views = await this.decryptMessages(sessionId, page.messages);
		this.store.applyMessages(sessionId, views);
		let maxSeq = this.lastSeq.get(sessionId) ?? 0;
		for (const message of page.messages) if (message.seq > maxSeq) maxSeq = message.seq;
		this.lastSeq.set(sessionId, maxSeq);
		await this.forwardSync(sessionId);
	}
	async forwardSync(sessionId) {
		if (!this.keys.has(sessionId)) return;
		let afterSeq = this.lastSeq.get(sessionId) ?? 0;
		while (true) {
			const page = await this.server.getMessages(sessionId, {
				afterSeq,
				limit: MESSAGES_PAGE_LIMIT
			});
			const views = await this.decryptMessages(sessionId, page.messages);
			this.store.applyMessages(sessionId, views);
			let maxSeq = afterSeq;
			for (const message of page.messages) if (message.seq > maxSeq) maxSeq = message.seq;
			this.lastSeq.set(sessionId, maxSeq);
			if (!page.hasMore || maxSeq === afterSeq) break;
			afterSeq = maxSeq;
		}
	}
	async handleUpdate(update) {
		if (!isRecord(update) || !isRecord(update.body) || typeof update.body.t !== "string") return;
		const body = update.body;
		const createdAt = typeof update.createdAt === "number" ? update.createdAt : Date.now();
		if (body.t === "new-message" && typeof body.sid === "string" && isRecord(body.message)) {
			await this.handleNewMessage(body.sid, body.message, createdAt);
			return;
		}
		if (body.t === "new-session") {
			await this.refreshSessions();
			return;
		}
		if (body.t === "delete-session" && typeof body.sid === "string") {
			this.openSessions.delete(body.sid);
			this.lastSeq.delete(body.sid);
			this.store.removeSession(body.sid);
			return;
		}
		if (body.t === "update-session" && typeof body.id === "string") {
			await this.handleUpdateSession(body.id, body, createdAt);
			return;
		}
	}
	async handleNewMessage(sessionId, message, createdAt) {
		if (!this.keys.has(sessionId)) {
			await this.refreshSessions();
			return;
		}
		const parsed = isRecord(message.content) && message.content.t === "encrypted" && typeof message.content.c === "string" && typeof message.id === "string" && typeof message.seq === "number" ? {
			id: message.id,
			seq: message.seq,
			content: {
				t: "encrypted",
				c: message.content.c
			},
			localId: typeof message.localId === "string" ? message.localId : null,
			createdAt: typeof message.createdAt === "number" ? message.createdAt : createdAt,
			updatedAt: createdAt
		} : null;
		if (!parsed) return;
		const raw = await this.decryptFor(sessionId, parsed.content.c);
		let thinking = null;
		if (isRecord(raw) && isRecord(raw.content)) {
			const contentType = raw.content.type;
			const data = isRecord(raw.content.data) ? raw.content.data : null;
			const dataType = data?.type;
			const evType = (data && isRecord(data.ev) ? data.ev : null)?.t;
			if ((contentType === "acp" || contentType === "codex") && (dataType === "task_complete" || dataType === "turn_aborted")) thinking = false;
			else if ((contentType === "acp" || contentType === "codex") && dataType === "task_started") thinking = true;
			else if (contentType === "session" && evType === "turn-end") thinking = false;
			else if (contentType === "session" && evType === "turn-start") thinking = true;
		}
		const current = this.store.getSnapshot().sessions.find((s) => s.id === sessionId);
		if (current) this.store.upsertSession({
			...current,
			updatedAt: createdAt,
			...thinking !== null ? { thinking } : {}
		});
		else await this.refreshSessions();
		const currentLastSeq = this.lastSeq.get(sessionId);
		if (currentLastSeq !== void 0) if (parsed.seq > currentLastSeq + 1) {
			if (this.openSessions.has(sessionId)) await this.forwardSync(sessionId);
		} else {
			const views = await this.decryptMessages(sessionId, [parsed]);
			this.store.applyMessages(sessionId, views);
			if (parsed.seq > currentLastSeq) this.lastSeq.set(sessionId, parsed.seq);
		}
	}
	async handleUpdateSession(sessionId, body, createdAt) {
		const current = this.store.getSnapshot().sessions.find((s) => s.id === sessionId);
		if (!current) {
			await this.refreshSessions();
			return;
		}
		if (!this.keys.has(sessionId)) return;
		const next = {
			...current,
			updatedAt: createdAt
		};
		if (isRecord(body.metadata) && typeof body.metadata.version === "number" && typeof body.metadata.value === "string") {
			const metadata = await this.decryptFor(sessionId, body.metadata.value);
			if (isRecord(metadata)) {
				if (isRecord(metadata.summary) && typeof metadata.summary.text === "string" && metadata.summary.text.length > 0) next.title = metadata.summary.text;
				if (typeof metadata.path === "string") next.path = metadata.path;
				if (typeof metadata.flavor === "string") next.agent = metadata.flavor;
				if (typeof metadata.machineId === "string") next.machineId = metadata.machineId;
			}
		}
		this.store.upsertSession(next);
	}
	handleEphemeral(update) {
		if (!isRecord(update) || update.type !== "activity" || typeof update.id !== "string") return;
		this.store.setSessionActivity(update.id, {
			thinking: update.thinking === true,
			active: update.active === true
		});
	}
};
//#endregion
//#region src/main/index.ts
function readServerConfiguration() {
	const value = process.env.HAPPY_SERVER_URL?.trim();
	if (!value) return {
		url: null,
		error: "HAPPY_SERVER_URL is required. Set it to the HTTP(S) origin of your Happy server before starting Electron."
	};
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("expected an HTTP(S) origin with no credentials, path, query, or fragment");
		return {
			url: parsed.origin,
			error: null
		};
	} catch (error) {
		return {
			url: null,
			error: `Invalid HAPPY_SERVER_URL: ${error instanceof Error ? error.message : "invalid URL"}`
		};
	}
}
var SERVER_CONFIGURATION = readServerConfiguration();
var mainDir = fileURLToPath(new URL(".", import.meta.url));
var mainWindow = null;
var engine = null;
var engineError = null;
var quitting = false;
var SUPPORTED_SPAWN_AGENTS = {
	omp: true,
	claude: true,
	codex: true,
	gemini: true,
	openclaw: true
};
function isSpawnSessionAgent(value) {
	return Object.hasOwn(SUPPORTED_SPAWN_AGENTS, value);
}
function parseSpawnSessionInput(value) {
	if (typeof value !== "object" || value === null) throw new Error("New session details are required");
	const input = value;
	const machineId = typeof input.machineId === "string" ? input.machineId.trim() : "";
	const directory = typeof input.directory === "string" ? input.directory.trim() : "";
	const agent = typeof input.agent === "string" ? input.agent.trim() : "";
	if (!machineId) throw new Error("Choose a machine before starting a session");
	if (!directory) throw new Error("Enter a directory before starting a session");
	if (!isSpawnSessionAgent(agent)) throw new Error("Choose a supported agent before starting a session");
	return {
		machineId,
		directory,
		agent
	};
}
async function loadCredentials(homeDir) {
	try {
		const raw = await readFile(join(homeDir, "access.key"), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string" && parsed.token.length > 0) return {
			token: parsed.token,
			homeDir
		};
		return null;
	} catch {
		return null;
	}
}
async function readDaemonPort(homeDir) {
	try {
		const raw = await readFile(join(homeDir, "daemon.state.json"), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && "httpPort" in parsed && typeof parsed.httpPort === "number" && Number.isInteger(parsed.httpPort) && parsed.httpPort > 0) return parsed.httpPort;
		return null;
	} catch {
		return null;
	}
}
function fallbackState(error) {
	return {
		status: "offline",
		sessions: [],
		messages: {},
		error
	};
}
function pushState(state) {
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("hd:state", state);
}
function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
async function bootEngine() {
	if (SERVER_CONFIGURATION.url === null) {
		const configurationError = SERVER_CONFIGURATION.error;
		engineError = configurationError;
		console.error("[happy-desktop]", configurationError);
		pushState(fallbackState(configurationError));
		return;
	}
	const homeDir = defaultHappyHomeDir();
	const credentials = await loadCredentials(homeDir);
	if (!credentials) {
		engineError = `No Happy credentials found at ${join(homeDir, "access.key")}`;
		console.warn("[happy-desktop]", engineError);
		pushState(fallbackState(engineError));
		return;
	}
	const port = await readDaemonPort(homeDir);
	engine = new SyncEngine({
		serverUrl: SERVER_CONFIGURATION.url,
		credentials,
		...port !== null ? { daemon: { port } } : {}
	});
	engine.on("state", (state) => pushState(state));
	try {
		await engine.start();
	} catch (err) {
		engineError = errorMessage(err);
		console.error("[happy-desktop] engine start failed:", err);
		pushState(fallbackState(engineError));
	}
}
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		backgroundColor: "#0a0a0b",
		webPreferences: {
			preload: join(mainDir, "../preload/index.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	mainWindow.webContents.on("did-finish-load", () => {
		if (engine) pushState(engine.getState());
		else if (engineError) pushState(fallbackState(engineError));
	});
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) mainWindow.loadURL(devUrl);
	else mainWindow.loadFile(join(mainDir, "../renderer/index.html"));
}
function requireEngine() {
	if (!engine) throw new Error(engineError ?? "Sync engine not started");
	return engine;
}
function registerIpc() {
	ipcMain.handle("hd:getState", () => {
		return engine?.getState() ?? fallbackState(engineError ?? "Sync engine not started");
	});
	ipcMain.handle("hd:send", (_event, sessionId, text) => {
		if (typeof sessionId !== "string" || typeof text !== "string") throw new Error("hd:send expects (sessionId: string, text: string)");
		return requireEngine().sendMessage(sessionId, text);
	});
	ipcMain.handle("hd:open", (_event, sessionId) => {
		if (typeof sessionId !== "string") throw new Error("hd:open expects (sessionId: string)");
		return requireEngine().openSession(sessionId);
	});
	ipcMain.handle("hd:spawn", (_event, input) => {
		const request = parseSpawnSessionInput(input);
		const syncEngine = requireEngine();
		if (!syncEngine.getState().sessions.some((session) => session.machineId === request.machineId)) throw new Error("The selected machine is no longer available in synced session metadata");
		return syncEngine.spawnSession(request.machineId, request.directory, request.agent);
	});
	ipcMain.handle("hd:stopSession", (_event, sessionId) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Choose an active session before stopping it");
		return requireEngine().killSession(sessionId.trim());
	});
}
app.whenReady().then(async () => {
	registerIpc();
	createWindow();
	await bootEngine();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});
app.on("window-all-closed", () => {
	app.quit();
});
app.on("before-quit", (event) => {
	if (!quitting && engine) {
		event.preventDefault();
		quitting = true;
		engine.stop().catch(() => void 0).finally(() => app.quit());
	}
});
//#endregion
export {};

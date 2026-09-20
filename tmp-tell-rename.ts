/**
 * One-off: tell every live happy session to rename its own chat.
 *
 * Posts a user message to each active session the same way the phone app does:
 * user-scoped socket, body encrypted with that session's key. The session's CLI
 * injects it into the omp child, which then calls its own change_title tool.
 *
 * Usage: node --import tsx tmp-tell-rename.ts [--dry] [--skip <sessionId>]...
 */
import fs from 'node:fs';
import { io, type Socket } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './packages/happy-cli/src/api/encryption';

const HAPPY_HOME = '/home/zarathustra/.omp-happy';
const BASE = 'http://127.0.0.1:40004';
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const SKIP = ARGS.flatMap((value, index) => (value === '--skip' ? [ARGS[index + 1]] : []));

const MESSAGE =
	'Rename this chat now. Call the change_title tool with a short, specific title for what this chat is working on, ' +
	'max 60 characters, no trailing punctuation. That is the whole task: one tool call, then stop.';

interface StoredSession {
	encryptionKey: string;
	encryptionVariant: string;
	metadata: { summary?: { text?: string } } | null;
}

const token: string = JSON.parse(fs.readFileSync(`${HAPPY_HOME}/access.key`, 'utf8')).token;
const stored: Record<string, StoredSession> = JSON.parse(
	fs.readFileSync(`${HAPPY_HOME}/sessions.json`, 'utf8'),
).sessions;

function connect(): Promise<Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const socket = io(BASE, {
		auth: { token, clientType: 'user-scoped' },
		path: '/v1/updates',
		transports: ['websocket'],
		withCredentials: true,
		reconnection: false,
	});
	const timer = setTimeout(() => reject(new Error('connect timeout')), 15000);
	socket.on('connect', () => {
		clearTimeout(timer);
		resolve(socket);
	});
	socket.on('connect_error', error => {
		clearTimeout(timer);
		reject(error);
	});
	return promise;
}

async function main() {
	const response = await fetch(`${BASE}/v2/sessions/active?limit=50`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const active = ((await response.json()) as { sessions?: Array<{ id: string; metadata?: string }> }).sessions ?? [];

	function titleOf(id: string, metadata: string | undefined): string | null {
		const record = stored[id];
		if (!record || typeof metadata !== 'string') return null;
		try {
			const body = decrypt(decodeBase64(record.encryptionKey), record.encryptionVariant as never, decodeBase64(metadata)) as {
				summary?: { text?: string };
			} | null;
			return body?.summary?.text ?? null;
		} catch {
			return null;
		}
	}

	const untitled = active.filter(entry => !SKIP.includes(entry.id) && !titleOf(entry.id, entry.metadata));
	console.log(`active sessions: ${active.length}, already titled: ${active.length - untitled.length}, to message: ${untitled.length}`);
	if (DRY) {
		for (const entry of untitled) console.log(`  would message ${entry.id}`);
		return;
	}

	const socket = await connect();
	let sent = 0;
	for (const entry of untitled) {
		const record = stored[entry.id];
		if (!record) {
			console.log(`  skip ${entry.id}: no local key`);
			continue;
		}
		const body = { role: 'user', content: { type: 'text', text: MESSAGE } };
		const payload = encodeBase64(encrypt(decodeBase64(record.encryptionKey), record.encryptionVariant as never, body));
		socket.emit('message', { sid: entry.id, message: payload });
		sent += 1;
	}
	await new Promise(resolve => setTimeout(resolve, 1500));
	socket.close();
	console.log(`sent to ${sent} session(s)`);

	const deadline = Date.now() + 300000;
	const named = new Map<string, string>();
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 15000));
		const refreshed = await (await fetch(`${BASE}/v2/sessions/active?limit=50`, {
			headers: { Authorization: `Bearer ${token}` },
		})).json() as { sessions?: Array<{ id: string; metadata?: string }> };
		for (const entry of refreshed.sessions ?? []) {
			if (!untitled.some(target => target.id === entry.id)) continue;
			const title = titleOf(entry.id, entry.metadata);
			if (title) named.set(entry.id, title);
		}
		console.log(`  renamed so far: ${named.size}/${untitled.length}`);
		if (named.size === untitled.length) break;
	}
	for (const [id, title] of named) console.log(`  ${id}  ${title}`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});

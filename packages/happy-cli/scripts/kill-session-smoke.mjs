/**
 * End-to-end check of the app's archive-swipe kill path:
 * connects user-scoped (like the phone app), sends the killSession RPC the
 * swipe sends, then reports the response and whether the runner died.
 *
 * Usage: node packages/happy-cli/scripts/kill-session-smoke.mjs <sessionId>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';

const sessionId = process.argv[2];
if (!sessionId) {
    console.error('usage: node kill-session-smoke.mjs <sessionId>');
    process.exit(1);
}

const home = process.env.HAPPY_HOME_DIR || join(process.env.HOME, '.omp-happy');
const access = JSON.parse(readFileSync(join(home, 'access.key'), 'utf8'));
const serverUrl = process.env.HAPPY_SERVER_URL || 'http://127.0.0.1:40004';

function encryptLegacy(data, secretB64) {
    const secret = Buffer.from(secretB64, 'base64');
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    const box = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const out = new Uint8Array(nonce.length + box.length);
    out.set(nonce);
    out.set(box, nonce.length);
    return Buffer.from(out).toString('base64');
}

function decryptLegacy(b64, secretB64) {
    const data = new Uint8Array(Buffer.from(b64, 'base64'));
    const secret = new Uint8Array(Buffer.from(secretB64, 'base64'));
    const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
    const box = data.slice(tweetnacl.secretbox.nonceLength);
    const opened = tweetnacl.secretbox.open(box, nonce, secret);
    return opened ? JSON.parse(new TextDecoder().decode(opened)) : null;
}

const list = await (await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(join(home, 'daemon.state.json'), 'utf8')).httpPort}/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const tracked = list.children.find(c => c.happySessionId === sessionId);
if (!tracked) {
    console.error('session not tracked by daemon:', sessionId);
    process.exit(1);
}
const encKey = tracked.encryption.key;

const { io } = await import('socket.io-client');
const socket = io(serverUrl, {
    auth: { token: access.token, clientType: 'user-scoped' },
    path: '/v1/updates',
    transports: ['websocket'],
    reconnection: false,
});
await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 10_000);
});

const started = Date.now();
const result = await socket.timeout(35_000).emitWithAck('rpc-call', {
    method: `${sessionId}:killSession`,
    params: encryptLegacy({}, encKey),
});
console.log(`killSession ack in ${Date.now() - started}ms:`, JSON.stringify(result));
if (result?.ok) {
    console.log('decrypted response:', JSON.stringify(decryptLegacy(result.result, encKey)));
}

// Give the runner a moment to tear down, then check process liveness.
await new Promise(r => setTimeout(r, 3000));
const alive = await new Promise(resolve => {
    process.kill(tracked.pid, 0);
    resolve(true);
}).catch(() => false);
console.log(`runner pid ${tracked.pid} ${alive ? 'STILL ALIVE' : 'exited'}`);
socket.disconnect();
process.exit(0);

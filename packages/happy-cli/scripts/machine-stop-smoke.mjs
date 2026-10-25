/**
 * End-to-end check of the app's archive fallback path: when the runner's
 * session RPC is unreachable, the app now calls the daemon's machine RPC
 * `stop-session`, which SIGTERMs the tracked process. This script sends
 * exactly that machine RPC from a user-scoped socket and reports whether
 * the tracked runner died.
 *
 * Usage: node packages/happy-cli/scripts/machine-stop-smoke.mjs <sessionId>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';

const sessionId = process.argv[2];
if (!sessionId) {
    console.error('usage: node machine-stop-smoke.mjs <sessionId>');
    process.exit(1);
}

const home = process.env.HAPPY_HOME_DIR || join(process.env.HOME, '.omp-happy');
const access = JSON.parse(readFileSync(join(home, 'access.key'), 'utf8'));
const machineId = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).machineId;
const serverUrl = process.env.HAPPY_SERVER_URL || 'http://127.0.0.1:40004';

function encryptLegacy(data, secretBytes) {
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    const box = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secretBytes);
    const out = new Uint8Array(nonce.length + box.length);
    out.set(nonce);
    out.set(box, nonce.length);
    return Buffer.from(out).toString('base64');
}

const list = await (await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(join(home, 'daemon.state.json'), 'utf8')).httpPort}/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const tracked = list.children.find(c => c.happySessionId === sessionId);
if (!tracked) {
    console.error('session not tracked by daemon:', sessionId);
    process.exit(1);
}

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

const secret = new Uint8Array(Buffer.from(access.secret, 'base64'));
const started = Date.now();
const result = await socket.timeout(35_000).emitWithAck('rpc-call', {
    method: `${machineId}:stop-session`,
    params: encryptLegacy({ sessionId }, secret),
});
console.log(`stop-session machine RPC ack in ${Date.now() - started}ms:`, JSON.stringify(result));

await new Promise(r => setTimeout(r, 3000));
const alive = await new Promise(resolve => {
    process.kill(tracked.pid, 0);
    resolve(true);
}).catch(() => false);
console.log(`runner pid ${tracked.pid} ${alive ? 'STILL ALIVE' : 'exited'}`);
socket.disconnect();
process.exit(0);

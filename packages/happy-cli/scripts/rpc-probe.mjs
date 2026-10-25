/**
 * Probe whether the server can route session RPCs to each tracked runner,
 * the same routing the app's archive swipe uses (sessionKill -> killSession).
 *
 * For every daemon-tracked session it calls `${sessionId}:listDirectory`
 * (registered by every session runner via registerCommonHandlers) with
 * properly encrypted params and measures the round trip:
 *   - fast (<2s)  -> runner socket is in the RPC room; killSession would reach it
 *   - slow (~15s) -> room empty; the swipe's kill RPC fails with "RPC call failed"
 *
 * Usage: HAPPY_SERVER_URL=http://127.0.0.1:40004 node packages/happy-cli/scripts/rpc-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';

const home = process.env.HAPPY_HOME_DIR || join(process.env.HOME, '.omp-happy');
const access = JSON.parse(readFileSync(join(home, 'access.key'), 'utf8'));
const token = access.token;
const serverUrl = process.env.HAPPY_SERVER_URL || 'http://127.0.0.1:40004';
const controlPort = JSON.parse(readFileSync(join(home, 'daemon.state.json'), 'utf8')).httpPort;

const listRes = await fetch(`http://127.0.0.1:${controlPort}/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const list = await listRes.json();

// Same wire format the app uses for session RPC params: secretbox, nonce prefixed.
function encryptLegacy(data, secretBytes) {
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    const box = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secretBytes);
    const out = new Uint8Array(nonce.length + box.length);
    out.set(nonce);
    out.set(box, nonce.length);
    return Buffer.from(out).toString('base64');
}

const { io } = await import('socket.io-client');
const socket = io(serverUrl, {
    auth: { token, clientType: 'user-scoped' },
    path: '/v1/updates',
    transports: ['websocket'],
    reconnection: false,
});

await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 10_000);
});
console.log('connected to', serverUrl);

async function probe(sessionId, encKey) {
    const started = Date.now();
    try {
        const secret = Buffer.from(encKey, 'base64');
        const result = await socket.timeout(25_000).emitWithAck('rpc-call', {
            method: `${sessionId}:listDirectory`,
            params: encryptLegacy({ path: '.' }, secret),
        });
        return { ms: Date.now() - started, ok: result?.ok, error: result?.error };
    } catch (e) {
        return { ms: Date.now() - started, ok: false, error: `ack: ${e.message}` };
    }
}

for (const child of list.children) {
    const enc = child.encryption ?? {};
    const r = await probe(child.happySessionId, enc.key);
    const verdict = r.ok ? 'ROUTABLE (runner socket live)' : (r.ms > 10_000 ? 'ROOM EMPTY (kill RPC would fail)' : 'ROUTED BUT HANDLER ERROR');
    console.log(`${child.happySessionId} pid=${child.pid} pane=${child.herdrPaneId ?? '-'} -> ${r.ms}ms ok=${r.ok} err=${r.error ?? '-'} ${verdict}`);
}

socket.disconnect();
process.exit(0);

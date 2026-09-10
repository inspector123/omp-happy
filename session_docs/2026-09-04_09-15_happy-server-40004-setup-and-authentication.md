# Happy Server 40004 Setup, Validation Fix, and Account Authentication

## Overview

This session established a new standalone Happy synchronization server listening on port `40004` on this workstation (`192.168.0.215`), replacing an unreachable server previously configured on port `30003` (`192.168.0.252:30003`). It resolved an upstream mobile app validation incompatibility when serving bundled web applications, established cryptographic account synchronization using the user's permanent secret key, and restored the background daemon service.

---

## What Was Wrong

1. **Dead Pre-existing Server Origin**:
   - The shell environment (`~/.zshrc`) and systemd daemon service (`omp-happy-daemon.service`) were configured to connect to `http://192.168.0.252:30003`.
   - That host and port were completely offline, leaving the background daemon continuously failing with connection timeouts and connection refused errors.

2. **Mobile App Rejected the New Server ("Not a valid Happy Server")**:
   - When entering `http://192.168.0.215:40004` into the companion mobile app, the app reported an error stating the server was not valid.
   - Investigation of `packages/happy-app/sources/app/(app)/server.tsx` revealed that the client validates server URLs by issuing a `GET /` request with an `Accept: text/plain` header and asserting that the response body contains the exact string `"Welcome to Happy Server!"`.
   - When `happy-server` is started in self-host mode with a static web application directory (`opts.staticDir`), Fastify's static asset handler takes over root requests and serves `index.html`. Because the raw HTML document did not contain `"Welcome to Happy Server!"`, the validation check failed.

3. **Terminal Linking Rejections ("Failed to connect terminal")**:
   - The companion app uses zero-knowledge end-to-end encryption with two distinct credentials:
     - A permanent 32-byte Secret Key (`UC4HC-NCV7L-FMZG6-LOMGU-I26US-YHYSN-VRCRO-AOUUJ-42A5K-6BQ2Y-KA`), which derives all encryption keys.
     - A temporary JWT session token signed by the server's internal master secret.
   - When changing the server URL in the companion app settings, the app updated its destination endpoint in local storage but retained the old server's session token.
   - When scanning the terminal authentication QR code, the app attempted to approve the terminal link via `POST /v1/auth/response` using the old session token. The new server rejected this token with HTTP 401 Unauthorized because the token signature did not match the new server's secret, displaying "Failed to connect terminal".

4. **PGlite Unclean Shutdown Abort**:
   - During an abrupt process stop, PGlite's write-ahead log was terminated between checkpoints, causing subsequent startup attempts to panic with `could not locate a valid checkpoint record` and `RuntimeError: Aborted()`.
   - The corrupted database directory was cleared and rebuilt cleanly with `--reset`.

5. **Foreign Key Constraint on Initial Machine Registration**:
   - When the workstation daemon attempted to register its machine ID (`3c21b584-235e-4ce9-bbd8-448564c14083`) via `POST /v1/machines`, Prisma threw error `P2003 (Foreign key constraint violated on Machine_accountId_fkey)` because the account record had not yet been committed to the database.
   - Running the cryptographic challenge exchange against `POST /v1/auth` created the account record, allowing machine registration to succeed.

---

## Debugging and Root-Cause Analysis

### Mobile App Server Validation
Inspecting `packages/happy-app/sources/app/(app)/server.tsx` showed the following verification logic:
```typescript
const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'text/plain' }
});
if (!response.ok) return false;
const text = await response.text();
if (!text.includes('Welcome to Happy Server!')) {
    setError(t('server.notValidHappyServer'));
    return false;
}
```
In `packages/happy-server/sources/app/api/api.ts`, lines 72-76 only registered the plain-text welcome route if no static web app directory was present:
```typescript
if (!opts.staticDir) {
    app.get('/', function (request, reply) {
        reply.send('Welcome to Happy Server!');
    });
}
```
When `opts.staticDir` was defined, Fastify served `packages/happy-app/dist/index.html`, which lacked the required string.

### Authentication and Session Architecture
Analysis of `packages/happy-server/sources/app/auth/auth.ts` and `packages/happy-app/sources/auth/` confirmed that user identities are public keys derived from a 32-byte Ed25519 secret key. The mobile client authenticates by signing a random challenge:
```typescript
const keypair = tweetnacl.sign.keyPair.fromSeed(secretBytes);
const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
// POST /v1/auth { challenge, signature, publicKey } -> returns session JWT
```
Because the user's permanent secret key was recovered from the phone, we were able to run this authentication sequence programmatically on the workstation, directly registering the account on the new server and writing the resulting valid credentials to `~/.omp-happy/access.key`.

---

## Changes Implemented

### 1. Server Validation Handler (`packages/happy-server/sources/app/api/api.ts`)
Added an `onRequest` lifecycle hook to intercept `GET /` requests. When a client requests plain text (or when no static directory is mounted), the server returns the expected plain text welcome banner. In addition, the welcome banner was injected as an HTML comment into static index pages for browser-based validation:
```typescript
app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const url = request.raw.url || '';
    if (request.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
        const accept = request.headers['accept'] || '';
        if (accept.includes('text/plain') || !opts.staticDir) {
            reply.type('text/plain').send('Welcome to Happy Server!');
            return reply;
        }
    }
});
```

### 2. Workstation Shell Configuration (`~/.zshrc`)
Updated line 111 of `~/.zshrc`:
```bash
export HAPPY_SERVER_URL=http://192.168.0.215:40004
```

### 3. Workstation Daemon Service (`~/.config/systemd/user/omp-happy-daemon.service`)
Updated line 11 to reference the new server origin:
```ini
Environment=HAPPY_SERVER_URL=http://192.168.0.215:40004
```
Reloaded the systemd daemon and restarted the service:
```bash
systemctl --user daemon-reload
systemctl --user restart omp-happy-daemon.service
```

### 4. Workstation Server Service (`~/.config/systemd/user/omp-happy-server.service`)
Created a durable systemd user unit for running the server on port `40004`:
```ini
[Unit]
Description=omp-happy server (sync backend on port 40004)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/zarathustra/projects/omp-happy
Environment=HOME=/home/zarathustra
Environment=HAPPY_HOME_DIR=/home/zarathustra/.happy-40004
Environment=PATH=/home/zarathustra/.local/bin:/home/zarathustra/.local/share/pi-node/node-v22.22.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/zarathustra/.local/share/pi-node/node-v22.22.3-linux-x64/bin/node /home/zarathustra/projects/omp-happy/packages/happy-cli/bin/happy.mjs server --host 0.0.0.0 --port 40004 --public-url http://192.168.0.215:40004 --no-persist
Restart=on-failure
RestartSec=5
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

### 5. Workstation Credentials (`~/.omp-happy/access.key` & `~/.omp-happy/settings.json`)
The user's Secret Key was converted from Base32 format (`UC4HC-NCV7L-FMZG6-LOMGU-I26US-YHYSN-VRCRO-AOUUJ-42A5K-6BQ2Y-KA`) into raw 32 bytes and authenticated with `POST /v1/auth`. The resulting session token and base64-encoded secret were written to `~/.omp-happy/access.key`, and machine ID `3c21b584-235e-4ce9-bbd8-448564c14083` was saved in `~/.omp-happy/settings.json`.

---

## Key Files and Directory Reference

| Path | Purpose |
| --- | --- |
| `/home/zarathustra/projects/omp-happy` | Main monorepo containing `happy-server`, `happy-cli`, and `happy-app`. |
| `~/.happy-40004/server-data/` | Server state, containing `master-secret`, embedded PGlite database, and local attachments. |
| `~/.omp-happy/access.key` | Workstation client authentication credentials (JSON containing `token` and `secret`). |
| `~/.omp-happy/settings.json` | Workstation client configuration containing `machineId: "3c21b584-235e-4ce9-bbd8-448564c14083"`. |
| `~/.config/systemd/user/omp-happy-server.service` | Systemd service unit for the sync server on port 40004. |
| `~/.config/systemd/user/omp-happy-daemon.service` | Systemd service unit for the daemon that bridges mobile app requests to local OMP sessions. |
| `~/.zshrc` | User shell profile configuring `HAPPY_SERVER_URL` and the terminal `omp` wrapper. |

---

## How-To Guide for Incoming Agents

If you are entering this environment with no prior context, use the following operational procedures:

### 1. Verify That the Server Is Running
Check whether port 40004 is active and returning healthy responses:
```bash
ss -tlnp | grep 40004
curl -s http://127.0.0.1:40004/health
curl -s -H "Accept: text/plain" http://127.0.0.1:40004/
```
Expected output:
- `/health` returns `{"status":"ok","timestamp":"...","service":"happy-server"}`.
- `/` with `Accept: text/plain` returns `Welcome to Happy Server!`.

### 2. Verify Workstation Authentication and Daemon Connection
Run the Happy CLI status command:
```bash
HAPPY_SERVER_URL=http://192.168.0.215:40004 HAPPY_HOME_DIR=~/.omp-happy node ~/projects/omp-happy/packages/happy-cli/bin/happy.mjs auth status
```
Expected output:
```text
Authentication Status
✓ Authenticated
✓ Machine registered
  Machine ID: 3c21b584-235e-4ce9-bbd8-448564c14083
  Host: amd
  Data directory: /home/zarathustra/.omp-happy
✓ Daemon running
```

### 3. Manage the Background Services
To restart or inspect the background daemon:
```bash
systemctl --user status omp-happy-daemon.service
systemctl --user restart omp-happy-daemon.service
tail -n 50 $(ls -t ~/.omp-happy/logs/*daemon*.log | head -n 1)
```

To manage the server process under OMP supervisor:
```bash
# Check supervisor status
hub ps
# Read server logs
hub logs --name happy-server-40004 --lines 50
```

### 4. Handling Mobile App Account Restores
If the mobile client loses connection or reports an error after a server reset:
1. Ensure the app server URL is set to `http://192.168.0.215:40004`.
2. Do not attempt to link with an existing session token from another server.
3. On the app Welcome screen, select **Restore with Secret Key**.
4. Enter the user's permanent Secret Key:
   ```text
   UC4HC-NCV7L-FMZG6-LOMGU-I26US-YHYSN-VRCRO-AOUUJ-42A5K-6BQ2Y-KA
   ```
5. The app will immediately acquire a valid token on the 40004 server and recognize workstation `amd` without needing a terminal QR scan.

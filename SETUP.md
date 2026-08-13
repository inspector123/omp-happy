# Self-hosted omp-happy setup

This guide starts a private Happy server from a clean clone, points every client
at it, and links computers without disturbing an existing hosted Happy account.
For production infrastructure and the complete environment reference, see
[`docs/deployment.md`](docs/deployment.md).

## Architecture and safety

- `happy-server` is the account, HTTP, and Socket.IO relay. It stores encrypted
  records but does not run coding agents.
- The Happy CLI and daemon run `omp` and other agents on each computer.
- Mobile, web, and Electron clients control those sessions. Every participant's
  app and CLI must use the same server origin.
- Credentials are server-specific. Changing a URL does not migrate an account or
  make credentials from one server valid on another.

Use a dedicated `HAPPY_HOME_DIR` for self-hosting. The commands below use
`~/.happy-self-host`, leaving the normal `~/.happy` account untouched. Do not
log out, use forced login, delete keys, or copy credentials merely to change
endpoints; select the correct home and URL instead.

## Prerequisites

- Node.js 20.19 or newer and pnpm 10.
- Git and `curl`.
- `omp` installed and authenticated with its model providers. Verify
  `omp acp --help`.
- For Android builds: Android SDK, Java, and `adb`.

## 1. Clone, install, and start the private server

```bash
git clone <your-fork-url> omp-happy
cd omp-happy
pnpm install

export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev
```

The root script builds the local CLI and invokes its existing `happy server`
command. On first start it:

- creates `$HAPPY_HOME_DIR/server-data`;
- generates `$HAPPY_HOME_DIR/server-data/master-secret` with 32 random bytes and
  mode `0600`;
- migrates an embedded PGlite database;
- uses local filesystem attachment storage; and
- asks before writing `settings.serverUrl` and `settings.webappUrl`.

Confirm the prompt only after checking that the printed data directory is the
isolated one above. Keep the server terminal running. From another terminal:

```bash
curl --fail http://127.0.0.1:3005/health
```

Success is HTTP 200 JSON with `"status":"ok"` and
`"service":"happy-server"`. The health route checks database connectivity.

### Trusted LAN

Loopback is suitable only when all clients run on the server computer. A phone
needs the computer's reachable LAN address:

```bash
export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url http://192.168.1.20:3005
```

`--host` is the bind address. `--public-url` is the origin written into client
settings and printed for health checks; it must be a valid HTTP(S) origin with
no path. The command requires it for wildcard binds so it never persists
`0.0.0.0` or an unusable loopback URL for phones. Replace the example with this
computer's LAN address and permit TCP 3005 through its local firewall.

Plain HTTP is acceptable only on a trusted local network. A phone off that
network cannot use the LAN URL.

### Public Internet

Bind the app server behind a reverse proxy:

```bash
export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url https://happy.example
```

Terminate TLS at the proxy, forward to `127.0.0.1:3005`, preserve `Host` and
`X-Forwarded-Proto`, and pass WebSocket upgrades on the Socket.IO path
`/v1/updates`. HTTPS clients then use WSS automatically. Use a publicly trusted
certificate; never expose login, bearer tokens, or sync traffic over public
HTTP.

## 2. Configure the mobile or web client before login

The self-host URL must be selected before an account is established:

1. Open the app's pre-login server selector.
2. Enter exactly the LAN or HTTPS origin printed by `happy server`.
3. Continue through the normal key-based login. Happy does not use an
   email/password account.

The app's persisted custom-server selection takes precedence over its build
default. For a custom mobile build, the canonical build-time variable is
`EXPO_PUBLIC_HAPPY_SERVER_URL`; `EXPO_PUBLIC_SERVER_URL` is not a sync setting.

The tracked Android project can build a release APK without regenerating native
files or changing its package ID:

```bash
cd packages/happy-app/android
EXPO_PUBLIC_HAPPY_SERVER_URL=http://192.168.1.20:3005 \
  ANDROID_HOME="$HOME/Android/Sdk" \
  ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

The tracked Android manifest permits cleartext for trusted LAN development.
Use `EXPO_PUBLIC_HAPPY_SERVER_URL=https://happy.example` for a public release.
Expo public variables are bundled into the app, so rebuild and reinstall after
changing one.

For local iOS development, pass the same variable to the existing package
script. iOS production policy permits local-network HTTP but requires HTTPS for
non-local public origins:

```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://192.168.1.20:3005 \
  pnpm --filter happy-app ios:dev
```

## 3. Link a CLI computer to the app account

The `self-host:dev` command has already built the local CLI. In a second
terminal, set the same server and isolated home explicitly:

```bash
cd /path/to/omp-happy
export HAPPY_HOME_DIR="$HOME/.happy-self-host"
export HAPPY_SERVER_URL=http://192.168.1.20:3005
export HAPPY_WEBAPP_URL="$HAPPY_SERVER_URL"

pnpm cli auth login
```

Choose **Mobile Authentication**. The CLI generates an ephemeral NaCl box
keypair, creates an auth request on this server, and displays a
`happy://terminal?...` QR containing only the ephemeral public key. Scan and
approve it in the already-authenticated app connected to the same server.

The app encrypts the authorization response to that ephemeral key and posts the
ciphertext to the server. The CLI polls, decrypts it locally, stores its bearer
token and client key material in `$HAPPY_HOME_DIR/access.key`, and registers a
machine ID. The server verifies public-key proofs and relays the encrypted
response; it does not receive the app's private account key or plaintext
session keys.

Verify and start the daemon:

```bash
pnpm cli auth status
pnpm cli daemon start
pnpm cli daemon status
pnpm cli acp omp --local
```

The daemon inherits `HAPPY_SERVER_URL` and `HAPPY_HOME_DIR` from the environment
that starts it. Keep those exports in the shell or service definition used to
start the daemon. Do not assume a GUI app, login shell, or service manager
inherits another terminal's environment.

## 4. Start the Electron client

Electron has no hosted or LAN fallback and does not perform a separate login.
It reads `access.key`, `agent.key`, daemon state, and local wrapped session keys
from the selected CLI home:

```bash
cd /path/to/omp-happy
HAPPY_HOME_DIR="$HOME/.happy-self-host" \
HAPPY_SERVER_URL=http://192.168.1.20:3005 \
  pnpm --filter happy-desktop dev
```

Missing or malformed `HAPPY_SERVER_URL` produces a blocking offline error; it
does not clear or rewrite credentials.

## 5. Onboard friends

Each friend should have a separate key-based account:

1. Give them the server's LAN URL (only while on that trusted LAN) or its public
   HTTPS URL. Do not give them server or client secrets.
2. They set that URL in their app before login, or install a build made with
   `EXPO_PUBLIC_HAPPY_SERVER_URL` set to it.
3. They open the configured app/web client to establish their own account key.
4. On their computer they choose their own isolated `HAPPY_HOME_DIR`, export the
   same `HAPPY_SERVER_URL`, run `pnpm cli auth login`, and approve their own QR.
5. They verify `pnpm cli auth status`, then start their daemon and sessions.

Share only the server origin and normal TLS certificate information. Keep these
boundaries:

- `HANDY_MASTER_SECRET` belongs only to the server operator. It derives
  server-side token/encryption keys and must be backed up with server data.
- The app's private account key remains on that person's app/web client.
- `$HAPPY_HOME_DIR/access.key` contains a bearer token and client key material.
  `agent.key` and local session files are also private client state.
- The server stores bearer identity and encrypted sync payloads, not plaintext
  prompts or raw session keys.

Never send another person a master-secret file, `access.key`, `agent.key`, or a
copy of your entire Happy home.

## 6. Troubleshooting without resetting credentials

- **Health works on the computer but not the phone:** the phone is using
  `127.0.0.1`, is off-LAN, or TCP 3005 is blocked. Use the advertised LAN origin.
- **App and CLI appear to have different accounts:** print
  `HAPPY_SERVER_URL` in the CLI shell and check the app's server screen. They
  must be identical origins. Correct the endpoint; do not log out or delete
  keys as a first step.
- **Electron is offline immediately:** launch it with both explicit variables
  and the same CLI home used during `auth login`.
- **Public HTTPS connects but live updates do not:** confirm the reverse proxy
  supports WebSocket upgrades on `/v1/updates`.
- **`omp` cannot spawn:** make sure `omp` is on the daemon's `PATH` and verify
  `omp acp --help` from the same environment.

See [`README.md`](README.md) for fork-specific agent features and
[`packages/happy-server/README.md`](packages/happy-server/README.md) for
standalone server details.

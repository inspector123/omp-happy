# OMP Happy setup from a clean machine

This guide takes a new user from a clean checkout to controlling native OMP from the OMP companion app.

## What gets installed

OMP Happy has three runtime pieces:

```text
Server computer
`-- Happy server
    `-- account, encrypted storage, and real-time routing

OMP computer
|-- native OMP
|-- forked CLI and Pi extension bridge
|-- background daemon
`-- herdr (recommended, or tmux)

Phone, web browser, or desktop
`-- OMP companion app
```

The server does not run OMP. Native OMP, provider credentials, project files, and tools remain on the OMP computer. The server stores and routes encrypted session records between the computer and companion.

## Decide where the server will run

Choose one server origin before creating accounts or linking computers. Every app, CLI, and daemon must use exactly that origin.

| Use case | Example origin | Notes |
|---|---|---|
| One computer only | `http://127.0.0.1:3005` | A physical phone cannot reach this. |
| Trusted LAN | `http://192.168.1.20:3005` | Works only while clients can reach that private network. |
| Internet access | `https://happy.example` | Requires a publicly trusted TLS certificate and WebSocket proxying. |

Do not switch origins as a troubleshooting shortcut. Accounts and credentials are server-specific; changing the URL does not migrate them.

The examples below use:

```bash
export OMP_HAPPY_REPO="$HOME/src/omp-happy"
export HAPPY_HOME_DIR="$HOME/.omp-happy"
export HAPPY_SERVER_URL="http://192.168.1.20:3005"
export HAPPY_WEBAPP_URL="$HAPPY_SERVER_URL"
```

Replace the repository path and server URL. Use the same values in every later shell or system service.

## 1. Install prerequisites

On the server and every OMP computer:

- Git
- Node.js 20.19 or newer
- pnpm 10
- `curl`

On every OMP computer:

- native `omp`
- valid OMP model-provider credentials
- herdr (recommended) or tmux, for phone-started desktop attachment

Optional mobile build requirements:

- Android: Android SDK, Java, and `adb`
- iOS: macOS, Xcode, and the normal Expo/iOS toolchain

Verify the basic tools:

```bash
node --version
pnpm --version
git --version
curl --version
omp --version
herdr --version
```

Native OMP must work before adding the companion bridge. Start `omp` normally and verify it can submit a prompt to the configured provider. OMP provider authentication is separate from companion login.

This repository does not install native OMP. Install it using the OMP project's normal distribution instructions, then note its absolute executable path if it is not `~/.local/bin/omp` or on `PATH`.

## 2. Clone and build OMP Happy

Run this on the server and each OMP computer. One machine may serve both roles.

```bash
git clone <your-fork-url> "$OMP_HAPPY_REPO"
cd "$OMP_HAPPY_REPO"
pnpm install
pnpm -C packages/happy-cli build
```

Do not use `npm install` or Yarn in this monorepo. pnpm manages the workspace dependencies.

The native bridge resolves the OMP executable in this order:

1. `OMP_HAPPY_REAL_BIN`
2. `~/.local/bin/omp`
3. `omp` on `PATH`

If necessary:

```bash
export OMP_HAPPY_REAL_BIN="/absolute/path/to/omp"
"$OMP_HAPPY_REAL_BIN" --version
```

## 3. Start the Happy server

Skip this section only if an operator has already given you a working server origin.

### Small private server on a trusted LAN

From the repository root on the server computer:

```bash
cd "$OMP_HAPPY_REPO"
export HAPPY_HOME_DIR="$HOME/.omp-happy-server"

pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url http://192.168.1.20:3005
```

Replace `192.168.1.20` with the server computer's LAN address. Permit inbound TCP port 3005 through its local firewall.

On first start, the command:

- builds the local CLI;
- creates `$HAPPY_HOME_DIR/server-data`;
- generates a persistent 32-byte master secret;
- migrates an embedded PGlite database;
- uses local attachment storage;
- asks before persisting the printed server and web URLs.

Confirm only after checking the printed data directory and origin. Keep this process running.

From another machine on the same network:

```bash
curl --fail http://192.168.1.20:3005/health
```

Expected response includes:

```json
{"status":"ok","service":"happy-server"}
```

Plain HTTP is suitable only for a trusted private network.

### Public server

For access away from the LAN, put the server behind a reverse proxy and use a public origin:

```bash
cd "$OMP_HAPPY_REPO"
export HAPPY_HOME_DIR="$HOME/.omp-happy-server"

pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url https://happy.example
```

The reverse proxy must:

- terminate HTTPS with a publicly trusted certificate;
- forward requests to the Happy server;
- preserve `Host` and `X-Forwarded-Proto`;
- pass WebSocket upgrades on `/v1/updates`.

Verify through the public endpoint:

```bash
curl --fail https://happy.example/health
```

Do not expose account, bearer-token, or synchronization traffic over public HTTP. See [`docs/deployment.md`](docs/deployment.md) for Docker, systemd, backups, PostgreSQL, Redis, S3, and multi-replica deployments.

### Persist the server

`pnpm run self-host:dev` stays attached to its terminal. For ongoing use, run the same server under a process supervisor such as systemd or use the standalone Docker deployment in `docs/deployment.md`.

A service deployment must preserve:

- its server data directory;
- the exact server master secret;
- the bind address, port, and public URL;
- automatic restart behavior;
- journal or file logs.

Back up the data and master secret together. Restoring only one is incomplete.

## 4. Install and configure the OMP companion

The self-hosted OMP-specific behavior comes from this repository's app build. An unrelated upstream Happy app may retain upstream defaults and branding, so do not assume a store build points at your private server.

### Existing compatible app build

If the operator supplied a compatible OMP companion build:

1. Install and open it.
2. Before creating an account, tap the server icon on the welcome screen.
3. Enter the exact server origin, such as `http://192.168.1.20:3005` or `https://happy.example`.
4. Save it and verify the hostname appears on the welcome screen.
5. Select **Create account**.

This setup is key-based. There is no Happy email/password account.

### Android release APK from source

Build the tracked release project without changing its configured package ID:

```bash
cd "$OMP_HAPPY_REPO/packages/happy-app/android"

EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
ANDROID_HOME="$HOME/Android/Sdk" \
  ./gradlew assembleRelease
```

List connected devices and use the listed transport ID:

```bash
adb devices -l
adb -t <transport-id> install -r \
  app/build/outputs/apk/release/app-release.apk
```

`-r` updates the existing companion installation while retaining its data. Do not change the `applicationId`; this project currently uses `gg.omp.companion.dev`.

The server URL is bundled into the app. Rebuild and reinstall after changing it. The tracked Android manifest permits cleartext LAN HTTP; use HTTPS for any public origin.

### iOS development build

On macOS:

```bash
cd "$OMP_HAPPY_REPO"
EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
  pnpm --filter happy-app ios:dev
```

Use HTTPS for a non-local public origin.

### Web client

The `happy server` command can serve a bundled web app when that artifact is available. Open the client URL printed by the server and make sure it points to the same origin. For source development:

```bash
cd "$OMP_HAPPY_REPO"
EXPO_PUBLIC_HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
  pnpm --filter happy-app web
```

Create the first account in one companion client. Additional companion clients should link or restore that account rather than accidentally creating unrelated accounts.

## 5. Link an OMP computer to the companion account

On the computer that will run OMP:

```bash
cd "$OMP_HAPPY_REPO"

export HAPPY_HOME_DIR="$HOME/.omp-happy"
export HAPPY_SERVER_URL="http://192.168.1.20:3005"
export HAPPY_WEBAPP_URL="$HAPPY_SERVER_URL"
export PATH="$PATH:$HOME/.local/bin"

pnpm cli auth login
```

Choose **Mobile Authentication**. The terminal displays a QR code.

In the already-authenticated OMP companion:

1. Open the action for linking a terminal/computer.
2. Scan the displayed QR code.
3. Approve the link.
4. Wait for the CLI to report success.

The QR contains a temporary public key. The companion encrypts the authorization response for that temporary key; the CLI decrypts it locally and stores its relay credentials under `$HAPPY_HOME_DIR`. Do not share this directory.

Verify:

```bash
pnpm cli auth status
```

If the app and CLI appear to have different accounts, compare the app's server screen with:

```bash
printf '%s\n' "$HAPPY_SERVER_URL"
printf '%s\n' "$HAPPY_HOME_DIR"
```

Correct the endpoint or home. Do not delete keys or force a new login as the first troubleshooting step.

## 6. Start the OMP daemon

The daemon keeps the OMP computer visible to the companion and accepts requests to create sessions.

```bash
cd "$OMP_HAPPY_REPO"

export HAPPY_HOME_DIR="$HOME/.omp-happy"
export HAPPY_SERVER_URL="http://192.168.1.20:3005"
export PATH="$PATH:$HOME/.local/bin"

scripts/omp-daemon.sh start
scripts/omp-daemon.sh status
```

The daemon inherits its environment at startup. Exporting a variable later in another shell does not update it. Restart the daemon after changing URLs, provider variables, executable paths, or rebuilding the CLI:

```bash
scripts/omp-daemon.sh restart
```

Stop it with:

```bash
scripts/omp-daemon.sh stop
```

### Recommended systemd user service

For a computer that should remain available after login, create:

```text
~/.config/systemd/user/omp-happy-daemon.service
```

Use absolute paths and substitute your real repository, Node, OMP, home, and server locations:

```ini
[Unit]
Description=OMP Happy daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/USER/src/omp-happy
Environment=HOME=/home/USER
Environment=HAPPY_HOME_DIR=/home/USER/.omp-happy
Environment=HAPPY_SERVER_URL=https://happy.example
Environment=PATH=/home/USER/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /home/USER/src/omp-happy/packages/happy-cli/bin/happy.mjs daemon start-sync
Restart=always
RestartSec=5
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now omp-happy-daemon.service
systemctl --user status omp-happy-daemon.service --no-pager
journalctl --user -u omp-happy-daemon.service -n 100 --no-pager
```

Use `daemon start-sync` in systemd. Do not use the detached `daemon start` command inside a service unit. `Restart=always` is safer than `Restart=on-failure` here because a clean daemon exit should not leave the computer offline indefinitely.

If the service must run without an active graphical login session, enable user lingering according to the host's operating policy:

```bash
sudo loginctl enable-linger "$USER"
```

## 7. Run the first native mirrored OMP session

First test from a terminal. This isolates the native bridge from remote-spawn and herdr/tmux concerns.

```bash
cd /path/to/a/project

HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="http://192.168.1.20:3005" \
OMP_HAPPY_REAL_BIN="${OMP_HAPPY_REAL_BIN:-$HOME/.local/bin/omp}" \
  node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" omp --verbose
```

Expected behavior:

1. The normal native OMP terminal UI opens.
2. Diagnostics report that the bundled OMP extension is ready.
3. A new OMP-flavored session appears in the companion.
4. A prompt typed in the terminal appears in the companion.
5. A prompt submitted in the companion reaches the same OMP conversation.
6. Assistant text, thinking, and tool activity render in both places.

To auto-approve tool calls for a trusted test machine:

```bash
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" omp --yolo
```

Use automatic approval carefully: OMP tools execute with the local user's OS permissions.

Pass native OMP arguments after `--`:

```bash
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" \
  omp -- --model claude-sonnet
```

## 8. Make bridged OMP the normal shell command

The optional launcher keeps updater, ACP, RPC, help, and version commands on the real OMP binary while routing normal interactive sessions through the Pi extension bridge.

Add a shell function to `~/.bashrc` or `~/.zshrc`:

```bash
omp() {
  local real_omp="$HOME/.bun/bin/omp"
  [[ -x "$real_omp" ]] || real_omp="$HOME/.local/bin/omp"

  OMP_HAPPY_REAL_BIN="$real_omp" \
    HAPPY_OMP_CLI="$HOME/src/omp-happy/packages/happy-cli/bin/happy.mjs" \
    HAPPY_HOME_DIR="$HOME/.omp-happy" \
    HAPPY_SERVER_URL="http://192.168.1.20:3005" \
    "$HOME/src/omp-happy/packages/happy-cli/scripts/omp-happy-launcher.sh" "$@"
}
```

Replace all paths and the server URL, then reload the shell:

```bash
source ~/.bashrc     # or source ~/.zshrc
omp --version       # bypasses the bridge
omp                 # starts a native mirrored session
```

Do not install the launcher over the native OMP binary. Native `omp update` owns that file.

## 9. Start a session from the companion

With the daemon online:

1. Open the companion.
2. Select **New session**.
3. Select the online computer.
4. Select or enter the project directory.
5. Select **omp** as the agent.
6. Choose the model and effort if desired.
7. Enter the first prompt.
8. Submit.

The daemon starts the internal native OMP command with auto-approval. If herdr is
available, it creates a herdr workspace and pane:

```text
workspace: happy-<timestamp>-omp
pane:      e.g. w2:p1
```

If herdr is not available but tmux is, it falls back to a tmux session and window:

```text
session: happy-omp
window:  happy-<timestamp>-omp
```

The companion opens the newly reported encrypted session after the daemon correlates it with the local process.

## 10. Attach to a phone-started session

Attach to the only active phone-started OMP session:

```bash
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" omp attach
```

If several sessions are active, the command lists their companion session IDs and herdr pane ids (or tmux targets for legacy sessions). Select one by ID prefix:

```bash
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" \
  omp attach <session-id-prefix>
```

With the shell launcher installed:

```bash
omp attach
omp attach <session-id-prefix>
```

This opens the exact live OMP terminal. It does not start a second conversation.
Detach without stopping OMP using herdr's detach keybinding (or tmux's default
`Ctrl-b d` binding for legacy tmux sessions).

Without herdr or tmux, phone-started sessions remain controllable from the
companion but cannot be attached to as native desktop terminals.

## 11. End-to-end acceptance check

A clean setup is complete only when all of these pass.

### Server

```bash
curl --fail "$HAPPY_SERVER_URL/health"
```

Expected: HTTP 200 with `"service":"happy-server"`.

### Native OMP

```bash
"${OMP_HAPPY_REAL_BIN:-$HOME/.local/bin/omp}" --version
```

Expected: the native OMP version, and a normal unbridged OMP prompt can contact its provider.

### Companion login

```bash
cd "$OMP_HAPPY_REPO"
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
  pnpm cli auth status
```

Expected: authenticated against the chosen server.

### Daemon

```bash
scripts/omp-daemon.sh status
```

Or, for systemd:

```bash
systemctl --user is-active omp-happy-daemon.service
```

Expected: active/connected, and the computer appears online in the companion.

### Local-to-companion bridge

1. Start the native bridge with `--verbose`.
2. Submit a prompt locally.
3. Confirm the companion shows it and the streamed response.
4. Submit a follow-up from the companion.
5. Confirm the same native OMP process receives it.

### Companion-to-terminal bridge

1. Create an OMP session from the companion.
2. Confirm the session starts and produces output.
3. Run `omp attach` locally.
4. Confirm the existing terminal opens (a herdr pane or tmux window).
5. Detach (herdr's detach keybinding, or `Ctrl-b d` for tmux).
6. Send another companion prompt and confirm the session continues.

## Troubleshooting

### Health works locally but not from the phone

The phone cannot use the server's `127.0.0.1`. Use the server's reachable LAN address or public HTTPS origin. Confirm the phone can open:

```text
http(s)://SERVER/health
```

Check the host firewall and routing.

### App and CLI show different accounts or no sessions

They are usually using different origins or credential homes.

```bash
printf 'server=%s\nhome=%s\n' "$HAPPY_SERVER_URL" "$HAPPY_HOME_DIR"
```

Compare the server origin character-for-character with the app's server screen. Scheme, hostname, and port all matter.

### Daemon starts and later disappears

Check:

```bash
scripts/omp-daemon.sh status
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" daemon list
```

For systemd:

```bash
systemctl --user status omp-happy-daemon.service --no-pager
journalctl --user -u omp-happy-daemon.service -n 200 --no-pager
```

Use `daemon start-sync` and `Restart=always` in the unit. Ensure the service has the correct `HOME`, `HAPPY_HOME_DIR`, `HAPPY_SERVER_URL`, `PATH`, provider variables, and absolute Node/repository paths.

### OMP cannot be found by the daemon

A systemd service does not load interactive shell initialization by default. Put the actual OMP directory in the service's `PATH`, or set `OMP_HAPPY_REAL_BIN` explicitly in the unit.

Verify in the daemon's effective environment, not only an interactive terminal.

### Bridge times out

Run:

```bash
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="$HAPPY_SERVER_URL" \
  node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" omp --verbose
```

A 15-second ready timeout means native OMP did not load the bundled Pi extension and connect to the temporary Unix socket. Check the native binary path, repository build, extension compatibility, and diagnostics.

### Session starts but tool calls block

Phone-started sessions use auto-approval. Manually started sessions do not unless `--yolo` is specified. If a tool opens a genuine password prompt, the bridge can send a secret-input request to the companion while an interactive bash call is active.

### `omp attach` reports no session

Attach only works for active daemon-started OMP sessions tracked with a herdr pane id or tmux target. Check:

```bash
herdr workspace list
node "$OMP_HAPPY_REPO/packages/happy-cli/bin/happy.mjs" daemon list
```

A terminal-started session is already local. A daemon-started process without herdr or tmux has no attach target.

### Do not use the legacy OMP path by accident

The native Pi extension path is:

```text
omp-happy-launcher.sh
`-- internal `omp` command
    `-- native OMP + omp-happy-bridge.mjs
```

The older script:

```text
scripts/omp-run.sh
`-- internal `acp omp --local --yolo`
```

uses the generic ACP integration and does not validate the native Pi extension bridge.

## Security and backup checklist

- Use HTTPS for any public server.
- Keep the server master secret outside source control.
- Back up server data and its master secret together.
- Never share `$HAPPY_HOME_DIR/access.key`, `agent.key`, an entire companion home, provider credentials, or the app's account key.
- Give each user a separate app account and CLI login.
- Treat daemon sessions using auto-approval as local-code execution by that account.
- Restrict server and machine access to intended users.
- Keep server, app, CLI, and daemon on the same explicit origin.

## Next reading

- [`README.md`](README.md): complete native OMP/Pi bridge architecture and protocol.
- [`SETUP.md`](SETUP.md): self-hosted account and client linking details.
- [`docs/deployment.md`](docs/deployment.md): production server deployment and backups.
- [`packages/happy-server/README.md`](packages/happy-server/README.md): standalone server behavior.

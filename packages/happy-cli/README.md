# Happy

Code on the go — control AI coding agents from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

## Usage

### Claude Code (default)

```bash
happy
# or
happy claude
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

### More agents

```
happy codex
happy gemini
happy openclaw

# or any ACP-compatible CLI
happy acp opencode
happy acp -- custom-agent --flag
```

## Daemon

The daemon is a background service that stays running on your machine. It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal.

```bash
happy daemon start
happy daemon stop
happy daemon status
happy daemon list
```

The daemon starts automatically when you run `happy`, so you usually don't need to manage it manually.

### Keeping the daemon running across reboots

If you want the daemon to come back automatically after a reboot — without opening a `happy` session first — start it from your shell profile so it inherits your normal user session context (PATH, keychain access, OAuth credentials):

```bash
# ~/.zshrc or ~/.bashrc
if [[ -o interactive ]] && [[ -z "$HAPPY_DAEMON_CHECKED" ]]; then
    export HAPPY_DAEMON_CHECKED=1
    () {
        local state=$HOME/.happy/daemon.state.json
        local pid=$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$state" 2>/dev/null | grep -oE '[0-9]+')
        if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
            happy daemon start >/dev/null 2>&1
        fi
    } &!
fi
```

The first interactive shell after a reboot triggers the start; subsequent shells short-circuit because the daemon is already running.

> **macOS users:** prefer this shell-init approach over a `launchd` LaunchAgent. A LaunchAgent runs in an agent domain that is **detached from your GUI/Aqua login session**, which means the bundled `claude-agent-sdk` cannot reach the macOS keychain and silently fails authentication ("Failed to authenticate. API Error: 401 terminated", `duration_api_ms: 0`). If you must use launchd, your wrapper has to read the OAuth access token from `~/.claude/.credentials.json` and export it as `CLAUDE_CODE_OAUTH_TOKEN` before exec'ing the daemon — and you'll need to handle token rotation yourself.

## Authentication

```bash
happy auth login
happy auth status
```

Happy uses cryptographic keys rather than an email/password account. For
self-hosting, configure the app first, then run login with
`HAPPY_SERVER_URL` pointing at the exact same server and approve the CLI's QR in
that app. Credentials are server-specific. The CLI stores its bearer token and
client key material under `HAPPY_HOME_DIR`; changing endpoints does not migrate
or clear it. See the repository's `SETUP.md` for the complete linking flow.

To connect third-party agent APIs:

```bash
happy connect gemini
happy connect claude
happy connect codex
happy connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happy` | Start Claude Code session (default) |
| `happy codex` | Start Codex mode |
| `happy gemini` | Start Gemini CLI session |
| `happy openclaw` | Start OpenClaw session |
| `happy acp` | Start any ACP-compatible agent |
| `happy resume <id>` | Resume a previous session |
| `happy notify` | Send push notification to your devices |
| `happy doctor` | Diagnostics & troubleshooting |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | API origin. Precedence: environment, `settings.json`, then the official hosted default. Always set it for self-hosting. |
| `HAPPY_WEBAPP_URL` | Web-auth origin. Precedence: environment, `settings.json`, then the official hosted default. Use the self-host origin when it serves the web app. |
| `HAPPY_HOME_DIR` | Happy data and credentials directory (default: `~/.happy`). Use a separate directory for each self-hosted account. |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention. |
| `HAPPY_EXPERIMENTAL` | Enable experimental features. |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happy sandbox configure
happy sandbox status
happy sandbox disable
```

### Building from source

```bash
git clone https://github.com/slopus/happy
cd happy
pnpm install
pnpm --filter happy build
node packages/happy-cli/bin/happy.mjs --help
```

## Requirements

- Node.js >= 20.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For Gemini: `npm install -g @google/gemini-cli` + `happy connect gemini`

## License

MIT

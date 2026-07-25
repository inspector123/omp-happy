# Native OMP sessions in Happy

- Branch: `feat/omp-happy-extension-bridge`
- Base: the repository's default remote branch, `origin/omp-backend`

This fork of [Happy](https://github.com/slopus/happy) runs the native OMP terminal UI while mirroring the same session to the OMP mobile/web app. A session can move between local terminal control and phone control without switching agents or starting a second OMP conversation.

The original Happy project supports Claude Code and Codex. This branch adds OMP-specific CLI, daemon, synchronization, and rendering paths. The relay protocol and encryption remain Happy's existing transport.

## What this branch adds

| Area | Behavior |
|---|---|
| Native OMP runtime | `happy omp` launches the installed OMP binary in a PTY with the bundled Happy extension. The native terminal UI remains visible and interactive. |
| Bidirectional bridge | A private temporary Unix socket carries OMP extension events to Happy and phone commands back to OMP. |
| Session handoff | Terminal input switches the session to local control; a phone prompt switches it to remote control. |
| Rich event mirroring | Assistant text, thinking, tool calls/results, errors, and todo updates are converted to Happy agent messages. |
| Phone input | Text, image attachments, model selection, abort, and session termination are forwarded to the live OMP process. |
| Remote spawn | The Happy daemon can start OMP from the phone. It uses tmux when available so the exact process remains attachable from the desktop. |
| Desktop attach | `happy omp attach [session-id]` attaches to the tmux window for a phone-started OMP session. |
| OMP rendering | The app recognizes OMP tool payloads, edit results, delegated tasks, thinking, todos, token usage, and model metadata. |
| Isolation and branding | `HAPPY_HOME_DIR` can isolate identity/state under `~/.omp-happy`; the companion app uses OMP branding and its own bundle identifier. |

## How it works

```text
native OMP TUI
    |
    | bundled extension events and commands
    v
temporary Unix socket
    |
    | packages/happy-cli/src/omp/runOmp.ts
    v
encrypted Happy session <----> Happy relay <----> OMP mobile/web app
```

The bridge extension is loaded with OMP's `--extension` option. It publishes the native OMP session ID and structured lifecycle events. The CLI converts those events into Happy's rich agent-message format instead of scraping terminal output.

Important paths:

- `packages/happy-cli/src/omp/runOmp.ts` — PTY lifecycle, Happy session, event conversion, and local/remote control.
- `packages/happy-cli/scripts/omp-happy-bridge.mjs` — extension-side socket protocol and OMP API integration.
- `packages/happy-cli/src/index.ts` — `happy omp` and `happy omp attach`.
- `packages/happy-cli/src/daemon/run.ts` — phone-started OMP sessions and tmux launch.
- `packages/happy-cli/src/daemon/controlServer.ts` — active-session metadata used by attach.
- `packages/happy-cli/src/utils/tmux.ts` — exact tmux window identifiers.
- `packages/happy-app/sources/components/tools/knownTools.tsx` — OMP tool presentation.
- `packages/happy-app/sources/sync/reducer/reducer.ts` — streamed OMP event reduction.

## Prerequisites

- Node.js and pnpm.
- A working native `omp` installation with provider credentials already configured.
- Access to a Happy-compatible relay and the OMP companion app.
- tmux for attaching to phone-started sessions. Without tmux, daemon launch falls back to a regular child process and desktop attach is unavailable.

The CLI resolves the native executable from `OMP_HAPPY_REAL_BIN`, then `~/.local/bin/omp`, then `PATH`.

## Build

```bash
pnpm install
pnpm -C packages/happy-cli build
```

## Run a native mirrored session

```bash
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="https://your-happy-relay.example" \
node packages/happy-cli/bin/happy.mjs omp
```

The first authenticated run performs Happy machine/account setup when needed. OMP continues to use its own provider credentials.

Useful forms:

```bash
# Print bridge diagnostics.
node packages/happy-cli/bin/happy.mjs omp --verbose

# Auto-approve OMP tool calls.
node packages/happy-cli/bin/happy.mjs omp --yolo

# Pass native OMP arguments after --.
node packages/happy-cli/bin/happy.mjs omp -- --model claude-sonnet

# Show the literal command help.
node packages/happy-cli/bin/happy.mjs omp --help
```

`--yolo` and `--dangerously-skip-permissions` both map to OMP auto-approval. Phone-started daemon sessions currently use auto-approval so remote tool calls do not block on an inaccessible terminal prompt.

## Start from the phone and attach locally

Start the daemon with the same isolated home and relay configuration:

```bash
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="https://your-happy-relay.example" \
node packages/happy-cli/bin/happy.mjs daemon start
```

Create an OMP session from the app. If tmux is installed, the daemon starts it in a `happy-omp` tmux session and records its exact window identifier.

Attach from the desktop:

```bash
node packages/happy-cli/bin/happy.mjs omp attach
node packages/happy-cli/bin/happy.mjs omp attach <happy-session-id-prefix>
```

When more than one phone-started OMP session is active, the command lists the available Happy session IDs and tmux targets and requires a selector.

## Optional command wrapper

`packages/happy-cli/scripts/omp-happy-launcher.sh` routes ordinary interactive OMP invocations through `happy omp`. It deliberately bypasses Happy for `acp`, `update`, RPC modes, help, and version commands.

Do not install the launcher over the native OMP binary: `omp update` replaces that path. Invoke it directly, or define an updater-independent shell function in `.zshrc`/`.bashrc`:

```zsh
omp() {
  local real_omp="$HOME/.bun/bin/omp"
  [[ -x "$real_omp" ]] || real_omp="$HOME/.local/bin/omp"
  OMP_HAPPY_REAL_BIN="$real_omp" \
    HAPPY_OMP_CLI="$HOME/src/happy/packages/happy-cli/bin/happy.mjs" \
    HAPPY_HOME_DIR="$HOME/.omp-happy" \
    HAPPY_SERVER_URL="https://your-happy-relay.example" \
    "$HOME/src/happy/packages/happy-cli/scripts/omp-happy-launcher.sh" "$@"
}
```

Replace `$HOME/src/happy` with this repository's path. The launcher bypasses Happy for updater and non-interactive commands, so the function can remain the default `omp` entry point.

The older `scripts/omp-run.sh` uses the generic ACP path and is not the native extension-bridge entry point documented here.

## Operational behavior

- The extension bridge listens on a socket inside a newly created temporary directory and removes that directory during shutdown.
- The CLI waits up to 15 seconds for the extension's ready frame.
- Output and thinking deltas are coalesced briefly before relay transmission.
- The session sends keepalives every two seconds and preserves local/remote control state.
- Phone images are downloaded, decrypted, converted to OMP image messages, and delivered with the prompt.
- The native OMP session ID is saved in Happy metadata for resume and session correlation.
- Normal terminal exit marks the relay session inactive without archiving it, so it remains in history and can be resumed. Explicit termination from the app archives it.
- Structured OMP advisor notes render as dedicated app cards with Markdown, severity, and source attribution.

## Current limitations

- Desktop attach requires tmux and applies only to active phone-started OMP sessions tracked by the daemon.
- The launcher script is a convenience wrapper, not an installer; its defaults must be reviewed before use.
- The native bridge and the older `happy acp omp` integration are separate paths. Use `happy omp` for the behavior described in this document.
- Delegated jobs render inside tool views; there is no standalone jobs panel.

## Validation

Observed on this branch:

```text
$ node packages/happy-cli/bin/happy.mjs omp --help
happy omp - Run the native OMP TUI with Happy sync
```

The following commands passed while preparing this README:

```bash
pnpm -C packages/happy-cli build
pnpm -C packages/happy-cli exec vitest run src/omp/runOmp.test.ts
```

The focused test run completed all 6 `runOmp` tests successfully.

An end-to-end relay/app session was not run while preparing this README.

## Upstream

See [`README.md`](README.md) for the original Happy overview and `LICENSE` for licensing.

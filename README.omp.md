# How the OMP companion talks to native OMP

This repository connects the native OMP terminal application to the OMP companion app. OMP still runs on the user's computer, inside the selected project directory, with its normal model credentials and tools. The companion app displays and controls that same process through an encrypted relay session.

This document covers the native Pi extension bridge. It does not describe the older generic ACP integration in `scripts/omp-run.sh`.

## Mental model

The companion is a remote interface, not a remote OMP runtime:

```text
OMP companion app
        |
        | encrypted Happy session protocol
        v
Happy-compatible relay
        |
        | encrypted Happy session protocol
        v
forked CLI wrapper: packages/happy-cli/src/omp/runOmp.ts
        |                                      |
        | PTY bytes                            | JSON lines over a private Unix socket
        v                                      v
native OMP terminal UI <----------> Pi extension: omp-happy-bridge.mjs
        |
        v
model provider, tools, and project files on the computer
```

There are three distinct communication layers:

1. **App to wrapper:** encrypted session messages pass through the Happy-compatible relay.
2. **Wrapper to OMP terminal:** a pseudoterminal carries terminal input, rendering, resize events, and exceptional interactive prompts.
3. **Wrapper to Pi extension:** a private Unix socket carries structured events and commands.

The wrapper does not scrape terminal output to reconstruct normal assistant messages or tool calls. The bundled Pi extension receives those as structured OMP events and publishes them to the wrapper.

## Names inherited from Happy

This fork retains internal names such as `happy.mjs`, `HAPPY_SERVER_URL`, `HAPPY_HOME_DIR`, and `happy-omp`. They come from the upstream Happy transport and CLI. An OMP user normally enters through the OMP launcher or companion app; they do not need to treat upstream `happy claude` as part of the OMP workflow.

## Do `happy X` commands run inside OMP?

No. There are three different command namespaces:

```text
shell command:  happy daemon start     -> controls the inherited companion CLI
shell command:  omp --model ...        -> starts or configures native OMP
OMP command:    /goal show              -> runs in OMP's interactive command parser
```

The Pi extension does not register a general `happy` command or `/happy` command inside OMP. The optional OMP launcher only translates an ordinary interactive `omp ...` process launch into the internal equivalent of `happy omp -- ...`; it does not make every inherited Happy subcommand an OMP feature.

In a development checkout, `pnpm cli X` and `node packages/happy-cli/bin/happy.mjs X` are the equivalents of a globally installed `happy X`.

| Inherited CLI command | Relationship to native OMP |
|---|---|
| `happy auth ...` | Works outside OMP. It manages the companion/relay login used by OMP sessions. It does not manage OMP's model-provider credentials. |
| `happy daemon ...` | Works outside OMP. The daemon can start native OMP sessions from the companion. |
| `happy omp` | The native extension-bridge entry point documented here. |
| `happy omp attach [id]` | Attaches to an active, daemon-started OMP tmux window. |
| `happy doctor` | Runs inherited CLI/daemon diagnostics. It is not an OMP self-test, so some checks and wording may concern upstream Happy behavior. |
| `happy notify` | Sends a companion notification independently of OMP. |
| `happy server` | Runs the self-hosted relay/server independently of OMP. |
| `happy connect` | Manages inherited AI-vendor connection settings. Native OMP continues to use its own provider configuration. |
| `happy sandbox` | Manages inherited Happy sandbox settings. The native bridge currently launches the OMP PTY directly; do not assume this command wraps native OMP in a sandbox. |
| `happy resume <happy-session-id>` | Recognizes OMP metadata, but currently resumes OMP through the older `acp omp --resume-omp` path rather than this native Pi extension bridge. |
| `happy acp omp ...` | Starts the older generic ACP integration, not the native extension bridge. |
| `happy omp-rpc` | Starts a separate prototype RPC wrapper, not the native extension bridge. |
| `happy`, `happy claude`, `happy codex`, `happy gemini`, `happy openclaw` | Start their respective inherited backends. They do not run within an OMP session. |

Arguments intended for native OMP must follow `--` when the internal native bridge command is invoked directly:

```bash
node packages/happy-cli/bin/happy.mjs omp -- --model claude-sonnet
```

The OMP launcher handles this forwarding automatically:

```bash
packages/happy-cli/scripts/omp-happy-launcher.sh --model claude-sonnet
```

Inside a running OMP TUI, use OMP's own slash commands. The bridge currently drives `/advisor`, `/compact snapcompact`, and `/goal` on behalf of app controls, but those remain OMP commands rather than inherited Happy CLI commands.

The relevant paths are:

| Path | Responsibility |
|---|---|
| `packages/happy-cli/scripts/omp-happy-launcher.sh` | Optional user-facing wrapper around ordinary `omp` invocations. |
| `packages/happy-cli/src/index.ts` | Internal `omp` and `omp attach` command dispatch. |
| `packages/happy-cli/src/omp/runOmp.ts` | Relay session, PTY, socket server, event translation, and cleanup. |
| `packages/happy-cli/scripts/omp-happy-bridge.mjs` | Pi extension loaded inside native OMP. |
| `packages/happy-cli/scripts/omp-happy-config.overlay.yml` | Forces a fresh OMP transcript unless an explicit resume is requested. |
| `scripts/omp-daemon.sh` | Convenience script for phone-initiated sessions. |
| `packages/happy-cli/src/daemon/run.ts` | Remote process creation and tmux integration. |
| `packages/happy-cli/src/utils/tmux.ts` | Tmux session/window creation and target formatting. |
| `packages/happy-app/sources/sync/reducer/reducer.ts` | Reduces synchronized events into app state. |
| `packages/happy-app/sources/components/tools/knownTools.tsx` | Renders known OMP tool payloads in the app. |

## Prerequisites

- Node.js and pnpm.
- A working native `omp` installation.
- OMP's model-provider credentials configured on the computer.
- An OMP companion app connected to a Happy-compatible relay.
- This fork's CLI built locally.
- Tmux if phone-started sessions must remain attachable from a desktop terminal.

Build the repository:

```bash
pnpm install
pnpm -C packages/happy-cli build
```

The wrapper resolves the native OMP executable in this order:

1. `OMP_HAPPY_REAL_BIN`, when set.
2. `~/.local/bin/omp`, when present.
3. `omp` from `PATH`.

The native OMP installation and the companion transport have separate authentication:

- OMP authenticates with the configured model provider.
- The forked CLI authenticates with the Happy-compatible relay.

## One-time companion login

Use an isolated CLI home so this fork does not share credentials or state with an unrelated upstream Happy installation:

```bash
cd /path/to/omp-happy

export HAPPY_HOME_DIR="$HOME/.omp-happy"
export HAPPY_SERVER_URL="https://your-relay.example"

pnpm cli auth login
```

Choose **Mobile Authentication**, then approve the displayed QR code in the companion app connected to the same relay.

The native OMP command also calls the automatic authentication/setup path when credentials are missing, but explicit login is easier to diagnose. There is no dedicated `login.sh` in this repository.

Verify the link:

```bash
pnpm cli auth status
```

Keep `HAPPY_HOME_DIR` and `HAPPY_SERVER_URL` identical when logging in, starting the daemon, launching OMP, and starting any desktop client. Relay identities and encrypted records are server-specific.

## Starting a native mirrored session

### Direct development command

From the repository:

```bash
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="https://your-relay.example" \
node packages/happy-cli/bin/happy.mjs omp
```

Useful forms:

```bash
# Show bridge diagnostics.
node packages/happy-cli/bin/happy.mjs omp --verbose

# Auto-approve native OMP tool calls.
node packages/happy-cli/bin/happy.mjs omp --yolo

# Forward native OMP arguments after `--`.
node packages/happy-cli/bin/happy.mjs omp -- --model claude-sonnet

# Show the wrapper command's help.
node packages/happy-cli/bin/happy.mjs omp --help
```

`--yolo` and `--dangerously-skip-permissions` both add OMP's auto-approval option. Phone-started sessions use auto-approval because an inaccessible terminal approval prompt would otherwise block remote work.

### OMP launcher

`packages/happy-cli/scripts/omp-happy-launcher.sh` makes the bridge usable as the normal `omp` entry point. It routes interactive OMP runs through the native extension bridge while bypassing the bridge for:

- `omp acp`
- `omp update`
- RPC and RPC-UI modes
- help and version requests

Invoke it directly, or define a shell function that survives native OMP updates:

```bash
omp() {
  local real_omp="$HOME/.bun/bin/omp"
  [[ -x "$real_omp" ]] || real_omp="$HOME/.local/bin/omp"

  OMP_HAPPY_REAL_BIN="$real_omp" \
    HAPPY_OMP_CLI="$HOME/src/omp-happy/packages/happy-cli/bin/happy.mjs" \
    HAPPY_HOME_DIR="$HOME/.omp-happy" \
    HAPPY_SERVER_URL="https://your-relay.example" \
    "$HOME/src/omp-happy/packages/happy-cli/scripts/omp-happy-launcher.sh" "$@"
}
```

Replace `$HOME/src/omp-happy` and the relay URL with the actual values. Do not overwrite the native OMP binary with this launcher: `omp update` owns that binary path.

## Native launch sequence

A direct or launcher-driven session follows this sequence:

```text
User starts bridged OMP
|
|-- index.ts
|   |-- authenticates the companion transport if necessary
|   |-- ensures a machine ID exists
|   |-- ensures the local daemon is running
|   `-- calls runOmp(...)
|
|-- runOmp.ts
|   |-- registers the machine with the relay
|   |-- creates one encrypted relay session with flavor: "omp"
|   |-- reports the session to the daemon
|   |-- creates /tmp/happy-omp-<random>/bridge.sock
|   |-- starts a Unix socket server
|   `-- starts native OMP in a PTY
|
`-- native OMP is launched with
    |-- --extension <repo>/packages/happy-cli/scripts/omp-happy-bridge.mjs
    |-- --config <repo>/packages/happy-cli/scripts/omp-happy-config.overlay.yml
    |-- OMP_HAPPY_BRIDGE_SOCKET=<temporary socket path>
    `-- OMP_HAPPY_CONTROL_MODE=remote
```

The wrapper passes the configuration overlay after user arguments. Its `autoResume: false` prevents a global OMP setting from making multiple new companion chats reuse the same OMP transcript. Explicit `--resume` still works through OMP's resume handling.

The wrapper waits up to 15 seconds for the extension's `ready` frame. If OMP exits first or the extension never connects, startup fails rather than publishing an apparently functional but unbridged session.

## The two local channels

### PTY channel

The wrapper starts OMP with `node-pty`. This preserves the real terminal application.

The PTY carries:

- terminal rendering from OMP to local stdout;
- local keyboard bytes to OMP;
- terminal resize events;
- Enter for slash commands that currently require OMP's TUI command parser;
- responses to detected password prompts;
- process signals and exit status.

PTY output is displayed locally. Except for password-prompt detection, it is not used as the source of mirrored assistant and tool events.

### Extension socket channel

The wrapper listens on a Unix-domain socket in a newly created temporary directory. The extension reads its location from `OMP_HAPPY_BRIDGE_SOCKET` and connects with `node:net`.

Both directions use newline-delimited JSON:

```text
{"type":"ready",...}\n
{"type":"agent_event","event":{...}}\n
{"type":"prompt","text":"..."}\n
```

The socket is local to the computer; the mobile app and relay never connect to it directly. If the connection closes unexpectedly, the extension retries after 250 ms. Frames produced before connection are queued. The wrapper also queues outbound commands until the primary extension connection is known.

On shutdown, the wrapper closes all socket connections and recursively removes the temporary bridge directory.

## Extension initialization

Native OMP imports `omp-happy-bridge.mjs` through `--extension` and calls its default export with the Pi extension API:

```js
export default function happyBridgeExtension(pi) {
  // Subscribe to Pi events, register tools, and accept commands.
}
```

If `OMP_HAPPY_BRIDGE_SOCKET` is absent, the extension returns without activating. When OMP emits `session_start`, the extension publishes:

```ts
type ReadyFrame = {
  type: "ready";
  protocolVersion: 1;
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  models?: Array<{
    code: string;          // "provider/model-id"
    value: string;
    description?: string;
  }>;
  currentModel?: string;
  thoughtLevels?: Array<{
    code: string;
    value: string;
    description?: string;
  }>;
  currentThoughtLevel?: string;
  title?: string;
};
```

The wrapper stores the native session ID as `ompSessionId` in relay metadata and publishes model, thinking-level, advisor, and title state to the app. A session switch or successful model/thinking-level change publishes a fresh snapshot.

## OMP to companion: structured event mirroring

The extension subscribes to Pi lifecycle events, including:

```text
agent_start                    tool_execution_start
agent_end                      tool_execution_update
turn_start                     tool_execution_end
turn_end                       tool_approval_requested
message_start                  tool_approval_resolved
message_update                 session.compacting
message_end                    session_compact
session_switch                 session_branch
session_shutdown               session_tree
goal_updated
```

It forwards each event as:

```ts
type AgentEventFrame = {
  type: "agent_event";
  event: PiEvent;
};
```

`runOmp.ts` translates the relevant events into the app's established agent-message format:

| Pi event | Companion result |
|---|---|
| `agent_start` | Marks the session busy and emits `task_started`. |
| `message_update` with `text_delta` | Appends streamed assistant output. |
| `message_update` with `thinking_delta` | Appends streamed thinking output. |
| `message_update` with an error | Displays the error as output. |
| `message_end` | Flushes fallback full text and structured advisor notes. |
| `tool_execution_start` | Emits a normalized tool-call card. |
| `tool_execution_update` | Updates delegated-task progress. |
| `tool_execution_end` | Emits the tool result and error state. |
| `agent_end` | Flushes output, emits `task_complete`, and marks the session ready. |
| `session_shutdown` | Releases delegated-task bindings. |

Small output and thinking deltas are coalesced for 150 ms before transmission. This reduces relay traffic while retaining streaming behavior. Switching between output and thinking flushes the previous stream immediately.

### Tool normalization

Native OMP tool names and input fields are normalized to identities already understood by the app. Examples include:

| Native OMP tool | Companion tool identity |
|---|---|
| `bash` or `shell` | `execute` |
| `grep` | `Grep` |
| `glob` | `Glob` |
| `write` | `Write` |
| `todo` | `TodoWrite` |
| `task` | `delegate_task` |
| `browser` | `fetch` |

Some input fields are also normalized where the app's compact tool card expects a different established name. Unknown tools retain their native name and still produce generic call/result events.

Todo results are converted into a normalized list of pending, in-progress, and completed entries. Duplicate snapshots are suppressed.

### Subagents and delegated tasks

The extension also listens for `task:subagent:lifecycle` and forwards child lifecycle frames. Child OMP sessions can connect to the same socket. The wrapper:

1. treats the first session ID as the primary bridge;
2. identifies child connections from their OMP session-file registry names;
3. binds each child to the corresponding `delegate_task` call;
4. buffers early child events until the binding is unambiguous;
5. namespaces child tool-call IDs;
6. mirrors child output, thinking, tools, and completion inside the parent task view.

Buffers and deduplication sets are bounded. Ambiguous, duplicate, or unbound child sockets are ignored rather than attached to the wrong delegated task.

## Companion to OMP: prompts and controls

The relay client in `runOmp.ts` receives app messages and converts them into socket commands.

### Text and image prompts

```text
User submits a prompt in the companion
|
|-- encrypted message reaches ApiSessionClient
|-- attachments are downloaded and decrypted locally
|-- binary images are encoded as base64 bridge payloads
|-- wrapper sends a prompt command through bridge.sock
`-- extension calls pi.sendUserMessage(...)
```

The command shape is:

```ts
type PromptCommand = {
  type: "prompt";
  text: string;
  images?: Array<{
    data: string;      // base64
    mimeType: string;
  }>;
  deliverAs?: "steer" | "followUp";
};
```

The extension filters malformed image entries and supplies Pi with either a plain string or multimodal content. If an OMP turn is already active, the wrapper uses `deliverAs: "steer"`; otherwise it submits a normal user message.

When a phone prompt specifies a model or effort level for a new turn, the wrapper sends those changes before the prompt. Model selection is also persisted through native OMP's configuration command runner.

### Abort behavior

The app's abort RPC becomes:

```ts
{ type: "abort" }
```

The extension calls `ctx.abort()` and returns `{ type: "aborted" }`. Prompts arriving while an abort is in progress are queued by the wrapper and released after OMP reports completion, preventing them from racing the cancelled turn.

### Model, thinking level, and title

The bridge supports:

```ts
{ type: "set_model"; spec: string }
{ type: "set_thinking_level"; level: string }
{ type: "set_title"; title: string }
```

The extension resolves a model by canonical `provider/id`, or by an unambiguous short ID/name, then calls `pi.setModel()`. It changes thinking through `pi.setThinkingLevel()` and the session title through `pi.setSessionName()` or the session manager fallback.

A successful state change publishes a new `ready` snapshot. Invalid requests return a `bridge_error` frame for diagnostics.

### Ask questions in the companion

The extension registers a Pi tool named `happy_ask`. This is an app-backed question tool and remains active whether the latest prompt came from the terminal or companion.

```text
OMP calls happy_ask
|
|-- extension stores a pending Promise by tool-call ID
|-- extension sends { type: "ask_request", id, questions }
|-- wrapper publishes a companion question/permission card
|-- user answers in the app
|-- wrapper sends { type: "ask_response", id, answers }
|-- extension resolves the pending tool execution
`-- OMP continues with the formatted answers
```

Cancelling the app question resolves it with an empty answer map so the OMP tool call is not left pending forever. Aborting the OMP tool rejects the pending Promise.

### Slash-command controls

Advisor, compact, and goal actions currently need OMP's interactive slash-command parser. The extension converts app RPCs to commands such as:

```text
/advisor on
/compact snapcompact
/goal set <objective>
/goal show
/goal pause
/goal resume
/goal drop
```

For these operations only:

1. the extension saves the current TUI editor text;
2. it places the slash command in the editor;
3. it sends `tui_command_ready` to the wrapper;
4. the wrapper writes Enter to the PTY;
5. the extension restores the previous editor text when it sees the command input event.

Ordinary remote prompts do not simulate keyboard input; they use `pi.sendUserMessage()`.

### Password prompts from terminal tools

A command running inside OMP may open a real password prompt, such as `sudo`. That prompt exists in PTY output rather than the structured Pi event stream.

While an interactive native `bash` tool call is active, the wrapper scans a bounded trailing PTY buffer for explicit or terminal-ending password prompts. It publishes a secret-input question to the companion. An approved response is written back to the PTY followed by Enter; cancellation sends Ctrl-C.

This is the main intentional exception to the rule that mirrored behavior comes from structured extension events.

## Local terminal input

When the wrapper is attached to a terminal, it enables raw mode and forwards local keystrokes directly to OMP's PTY. OMP remains the actual terminal UI, so normal navigation and editing continue to work.

Phone prompts and local keystrokes can both reach the same native OMP process. The current implementation initializes relay state as `remote` and does not toggle that state merely because local keys were pressed. The mode field is used for session presence/compatibility and extension setup; it is not a lock that excludes one input source.

## Starting sessions from the companion

The daemon lets the app create OMP sessions without someone first opening a project terminal.

Start it with the same relay and isolated home used during login:

```bash
cd /path/to/omp-happy
export HAPPY_HOME_DIR="$HOME/.omp-happy"
export HAPPY_SERVER_URL="https://your-relay.example"

scripts/omp-daemon.sh start
```

Other daemon operations:

```bash
scripts/omp-daemon.sh status
scripts/omp-daemon.sh restart
scripts/omp-daemon.sh stop
```

The script is a convenience wrapper around the repository's internal daemon command. The daemon inherits its server URL, credentials home, provider variables, and `PATH` from the environment in which it starts. Restart it after changing environment variables or rebuilding the CLI.

### Phone-started launch flow

```text
User creates an OMP session in the companion
|
|-- relay delivers a spawn request to the local daemon
|-- daemon validates and expands requested environment variables
|-- daemon selects the requested project directory
|-- daemon checks whether tmux is available
|
|-- with tmux
|   |-- creates/uses session "happy-omp"
|   |-- creates window "happy-<timestamp>-omp"
|   |-- starts: internal CLI omp --yolo --started-by daemon
|   `-- records PID and exact session:window target
|
`-- without tmux
    `-- starts the same internal CLI as a regular child process
```

The daemon waits up to 15 seconds for the new wrapper to report its encrypted companion session ID. This correlates the process/tmux window with the chat visible in the app.

## Tmux and desktop attach

Tmux is a process/terminal container around the bridge, not part of its protocol:

```text
tmux session: happy-omp
`-- window: happy-<timestamp>-omp
    `-- forked CLI wrapper
        |-- native OMP PTY
        |   `-- Pi extension
        `-- private Unix socket
```

Attach to the only active phone-started OMP session:

```bash
node packages/happy-cli/bin/happy.mjs omp attach
```

If more than one is active, use the beginning of the companion session ID:

```bash
node packages/happy-cli/bin/happy.mjs omp attach <session-id-prefix>
```

The launcher also routes `omp attach ...` to this internal attach command. Internally, attach resolves the daemon-recorded exact `session:window` target and calls:

```bash
tmux attach-session -t <session:window>
```

This opens the same native OMP process. It does not create or resume a second conversation. Detach without stopping it with tmux's default `Ctrl-b d` binding.

Without tmux, phone-started OMP still runs and remains controllable from the app, but native desktop attach is unavailable.

## Relay session and encryption boundary

`runOmp.ts` creates a relay machine/session using the fork's existing encrypted session protocol. The relay carries encrypted records between the wrapper and companion clients. The private bridge socket never leaves the computer.

The practical trust boundaries are:

- **Native OMP and wrapper:** can access the selected project and local tools according to the user's OS permissions.
- **Companion client:** holds account/session key material needed to display and control sessions.
- **Relay:** routes and stores encrypted synchronization records but does not connect to OMP's local socket.
- **Tmux:** retains the local terminal process; it does not handle relay encryption or structured event conversion.

Do not share `$HAPPY_HOME_DIR/access.key`, `$HAPPY_HOME_DIR/agent.key`, model-provider credentials, or relay server secrets.

## Keepalive, reconnection, and lifecycle

- The wrapper sends relay keepalives every two seconds with thinking and mode state.
- Relay reconnection can replace the active `ApiSessionClient` while preserving the native process.
- The extension reconnects its Unix socket after a local disconnect.
- The extension republishes `ready` after reconnecting once it has session context.
- A normal native OMP exit flushes pending text, marks the relay session dead/inactive, and leaves it in history.
- Explicit app termination sets the relay session lifecycle to archived, terminates the PTY child, and closes the session.
- If OMP exits during an active turn, the wrapper emits `turn_aborted`.
- Relay flush and close each have a five-second shutdown bound.
- The wrapper terminates the child, closes the socket server, and removes the temporary directory in `finally` cleanup.

## Protocol summary

### Extension to wrapper

```ts
type ExtensionFrame =
  | ReadyFrame
  | { type: "agent_event"; event: PiEvent }
  | { type: "subagent_lifecycle"; payload: SubagentLifecycle }
  | { type: "input"; text: string; source: "interactive" | "rpc" | "extension" }
  | { type: "ask_request"; id: string; questions: Question[] }
  | { type: "change_title"; title: string }
  | { type: "tui_command_ready"; command: string }
  | { type: "aborted" }
  | { type: "bridge_error"; message: string };
```

### Wrapper to extension

```ts
type WrapperCommand =
  | PromptCommand
  | { type: "set_control_mode"; mode: "local" | "remote" }
  | { type: "abort" }
  | { type: "set_model"; spec: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_title"; title: string }
  | { type: "set_advisor"; enabled: boolean }
  | { type: "compact_snapcompact" }
  | { type: "goal_command"; action: "set" | "show" | "pause" | "resume" | "drop"; objective?: string }
  | { type: "ask_response"; id: string; answers: Record<string, string | string[]> };
```

These are internal, versioned implementation shapes, not a public network API. Protocol version 1 is currently reported in the `ready` frame.

## Troubleshooting

### The app cannot see the computer

Check that login and daemon startup use the same values:

```bash
echo "$HAPPY_HOME_DIR"
echo "$HAPPY_SERVER_URL"
pnpm cli auth status
scripts/omp-daemon.sh status
```

A daemon does not automatically inherit variables later exported in another terminal. Restart it from the correctly configured environment.

### Native OMP does not start

First verify OMP independently of the bridge:

```bash
"${OMP_HAPPY_REAL_BIN:-$HOME/.local/bin/omp}" --version
```

If OMP lives elsewhere, set `OMP_HAPPY_REAL_BIN` to its absolute path. OMP's provider authentication must already work locally.

### Startup times out waiting for the extension

Run the native bridge with diagnostics:

```bash
HAPPY_HOME_DIR="$HOME/.omp-happy" \
HAPPY_SERVER_URL="https://your-relay.example" \
node packages/happy-cli/bin/happy.mjs omp --verbose
```

A timeout means native OMP did not load the bundled extension and publish `ready` within 15 seconds. Check the native binary path, extension compatibility, repository build, and diagnostic output.

### Phone prompts arrive but tools block

Phone-started daemon sessions include `--yolo`. A manually started session does not unless requested. Use:

```bash
node packages/happy-cli/bin/happy.mjs omp --yolo
```

Only enable automatic approval when the machine and relay account are trusted, because OMP tools execute with the local user's permissions.

### Desktop attach finds no session

Attach only applies to active OMP sessions started by the daemon and tracked with a tmux target. Check:

```bash
scripts/omp-daemon.sh status
node packages/happy-cli/bin/happy.mjs daemon list
tmux list-sessions
```

A locally started bridged terminal is already attached, and a daemon session started without tmux has no attach target.

### The wrong OMP session resumes

New companion chats receive the bundled `autoResume: false` overlay. Do not remove or reorder that overlay. Use an explicit OMP resume argument only when resuming is intended.

## Native bridge versus legacy ACP path

This repository contains two OMP integrations:

```text
packages/happy-cli/scripts/omp-happy-launcher.sh
`-- internal `omp` command
    `-- native OMP TUI + bundled Pi extension bridge

scripts/omp-run.sh
`-- internal `acp omp --local --yolo`
    `-- older generic ACP integration
```

Use the launcher/native internal `omp` command for the behavior documented here. The ACP script does not exercise `omp-happy-bridge.mjs` and should not be used to validate the Pi extension path.

## Current limitations

- Desktop attach requires tmux and only covers active daemon-started sessions recorded by the running daemon.
- Phone-started sessions use automatic tool approval.
- Some app actions use TUI slash-command injection because Pi does not expose the required operation directly through the extension API used here.
- Password prompt forwarding depends on bounded PTY prompt detection and only runs while a native interactive bash tool is active.
- The launcher is a convenience script, not an installer; its paths and relay URL must be configured.
- Delegated-task activity renders within tool views rather than a separate jobs panel.
- Internal source and environment names still use Happy terminology inherited from the upstream transport.

## Focused verification

The native command exposes its bridge help with:

```bash
node packages/happy-cli/bin/happy.mjs omp --help
```

Relevant focused checks are:

```bash
pnpm -C packages/happy-cli build
pnpm -C packages/happy-cli exec vitest run \
  src/omp/runOmp.test.ts \
  scripts/omp-happy-bridge.test.ts
```

A full end-to-end check additionally requires a configured relay, companion client, native OMP provider credentials, and—when desktop attach is being tested—tmux.

## Upstream

See [`README.md`](README.md) for the repository-wide overview, [`SETUP.md`](SETUP.md) for self-hosted relay and client setup, and [`LICENSE`](LICENSE) for licensing.

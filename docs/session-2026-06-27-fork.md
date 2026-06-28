# omp-happy — fork Happy to drive omp as a first-class agent

- **Date:** 2026-06-27
- **Session ID:** 7dba7bfe-40fb-4f22-a3a4-302e095978d1
- **Repo:** `~/projects/omp-happy` → github.com/inspector123/omp-happy (private, branch `omp-backend`)
- **Specs:** `~/omp-happy-build-spec.md` (blueprint) · `~/happy-system-map.md` (Happy reference)
- **Goal:** a Happy clone where **omp (oh-my-pi)** is the agent — driven from the phone over Happy's E2E relay, with the same UX as the Claude flow (live sessions, spawn-from-phone, reasoning, todos, etc.).

---

## TL;DR — what shipped

A working **OMP** Android app (installed on the phone) + a forked `happy` CLI that drives omp as a first-class agent. 7 feature commits on `omp-backend`:

1. **omp as a first-class ACP agent (Path B delivery)** — the core
2. **app: first-class omp rendering** (subagents/DelegateView, tool kinds, provider)
3. **app: rebrand to OMP** (distinct bundle id)
4. **feat: spawn omp sessions remotely from the phone** (daemon)
5. **app: curated model shortlist** (tame omp's 40+ model list)
6. **app: show agent reasoning blocks**
7. **cli: surface omp plan/todos and usage/cost**

---

## The decisive architecture finding (why a naive port fails)

Registering `omp acp` as a *generic* ACP agent gives the **Gemini-or-worse** experience. Happy's good UX is **not** a property of ACP — it's a tool-name-aware + `metadata.flavor`-aware rendering stack. There are **two message-delivery paths**:

- **Path A — session-protocol** (`session.sendSessionProtocolMessage` → `AcpSessionManager`). Used by the generic `runAcp`, openclaw, codex. **The app normalizer hardcodes tool-call-end results to `null`** (`happy-app/sources/sync/typesRaw.ts` ~L666). ⇒ Path A can **never** show tool results. This is why ACP agents feel worse.
- **Path B — unified ACP data** (`session.sendAgentMessage(provider, {type:'tool-result', output,…})` → app `type:'acp'`). Used by **Gemini's dedicated `runGemini.ts`**. `output` lands in `tool.result` → rich rendering. **The provider enum was closed** to `claude/codex/gemini/opencode`.

**Fix:** keep `runAcp`'s transport/prompt-loop/permissions/modes/slash infra, but **swap the sink** for omp — emit each backend `AgentMessage` via `sendAgentMessage('omp', …)`, mapping to the exact `acp` data shapes `runGemini` uses. (`MessageAdapter.ts` looked like a shortcut but its field names — `toolResult`/`toolArgs` — don't match the app schema `output`/`input`; runGemini's inline shapes are canonical.)

omp's ACP wire format is actually RICH: tool_call carries `kind` (read/edit/execute/search/fetch/think/other) + human `title` + `rawInput` + `rawOutput` + `locations`; chunks carry `messageId`; `usage_update` has cost; `plan` updates carry `entries`; `available_commands_update` streams all 25+ commands; `configOptions` carries dynamic mode/model selects. The loss was happy-cli dropping it.

---

## What changed, by area

### CLI (`packages/happy-cli`)
- `agent/acp/acpAgentConfig.ts` — register `omp: {command:'omp', args:['acp']}`.
- `agent/acp/sessionUpdateHandlers.ts` — read tool args from `rawInput` (omp uses that, not `content`), forward real `title`, detect `delegate_task` via `rawInput.tasks[]` (`deriveToolName`), read results from `rawOutput ?? content`, handle ACP `plan` `entries`.
- `agent/acp/AcpBackend.ts` — dispatch `usage_update` → `event:usage`.
- `agent/acp/AcpSessionManager.ts` / `core/AgentBackend.ts` — thread the human `title` through.
- `agent/acp/runAcp.ts` — **the Path-B sink** (`useMobileSink`/`emitOmpMobile`/`flushOmpText`): model-output (accumulated), thinking, tool-call, tool-result, fs-edit, + `task_started/complete/turn_aborted` lifecycle. Plus: `plan` → synthesized **TodoWrite** tool call (reuses app TodoView); `usage` → compact `📊 used/size tokens · $cost` line.
- `agent/adapters/MobileMessageFormat.ts`, `api/apiSession.ts` — add `omp` to `MobileAgentType` / `sendAgentMessage` provider union.
- **Daemon spawn:** `utils/detectCLI.ts` (advertise omp), `api/types.ts` + `api/apiMachine.ts` (cliAvailability.omp), `daemon/controlServer.ts` (enum) + `daemon/run.ts` (both tmux + regular spawn paths → `happy acp omp --started-by daemon`, **omitting** `--happy-starting-mode` which the acp parser would leak into omp's args), `modules/common/registerCommonHandlers.ts` (type).

### App (`packages/happy-app`)
- `sync/typesRaw.ts` — add `omp` to the acp `provider` enum.
- `components/tools/views/DelegateView.tsx` (NEW) + `_all.tsx` + `knownTools.tsx` — render `delegate_task` subagents (merge `input.tasks[]` + `result.details.progress[]/results[]` by task id) and add `fetch`/`delegate_task` entries.
- `app.config.js` — name "OMP", package `gg.omp.companion(.dev/.preview)`, scheme `omphappy`, drop upstream `google-services.json`.
- **Spawn picker:** `app/(app)/new/index.tsx` (ALL_AGENTS += omp, icon), `sync/{persistence,storageTypes,ops}.ts` (agent type + cliAvailability + spawn type).
- **Model shortlist:** `sync/settings.ts` (`modelShortlist`), `app/(app)/settings/models.tsx` (NEW page), `app/(app)/_layout.tsx` (route), `components/AgentInput.tsx` (filter + "Manage models…" link).
- **Reasoning:** `sync/settings.ts` (`showReasoning`), `components/MessageView.tsx` (render `isThinking` as a muted "Reasoning" block instead of `return null`), `app/(app)/settings/appearance.tsx` (toggle).

### Limitations / not done
- **Advisor notes** can't be badged separately: omp's ACP strips model-role tags, so advisor notes arrive indistinguishable from normal output/reasoning (they DO show now that reasoning renders, just inline).
- **Standalone `/jobs` panel** not built (jobs already show inside DelegateView; standalone would need an APK rebuild + overlaps).
- `usesCleartextTraffic="true"` lives in the **generated** `android/` dir (gitignored) → lost on a fresh `expo prebuild`; make durable via `expo-build-properties` if re-prebuilding.

---

## Operational runbook

### Isolation (important)
The fork uses a **separate account** so it never touches your real Happy. Everything (identity `access.key`, sessions, daemon state) derives from `HAPPY_HOME_DIR` (`configuration.ts:37-50`). The helpers set `HAPPY_HOME_DIR=~/.omp-happy`. **Never run the forked `bin/happy.mjs` bare** (no env) — that uses your real `~/.happy`.

### Servers (split addressing — same physical server)
- **CLI / daemon →** LAN `http://192.168.0.252:30003` (from zshrc `HAPPY_SERVER_URL`).
- **App →** external `http://50.47.26.175:30003` (baked into the APK at build via `EXPO_PUBLIC_HAPPY_SERVER_URL`; needs `usesCleartextTraffic`).
- Pairing works across both because the QR carries only the keypair, not a URL.

### Prepare omp for remote use
1. Configure omp's provider auth normally with regular `omp` (keys live under `~/.omp`).
2. Start the daemon (registers this machine so the phone can spawn omp):
   ```bash
   ~/omp-happy-daemon.sh start     # status | stop | restart (restart after pulling new CLI code)
   ```
3. First time only — pair the OMP app: run `~/omp-happy-run.sh`, pick **Mobile**, scan the terminal QR with the **OMP (dev)** app. (Writes `~/.omp-happy/access.key`.)

### Two ways to run a session
- **Foreground (one session):** `~/omp-happy-run.sh` → runs `happy acp omp`, stays alive as the session; drive it from the phone.
- **From the phone (needs daemon up):** ＋ New session → **omp** → pick machine/folder → spawn.

### Build / deploy the app (after app changes)
```bash
cd ~/projects/omp-happy/packages/happy-app
ANDROID_HOME=$HOME/Android/Sdk npx expo prebuild --platform android --no-install   # only if not already prebuilt
cd android
EXPO_PUBLIC_HAPPY_SERVER_URL=http://50.47.26.175:30003 \
  ANDROID_HOME=$HOME/Android/Sdk ./gradlew assembleRelease --no-daemon
adb install -r app/build/outputs/apk/release/app-release.apk
```
**Gradle gotchas:** bump `android/gradle.properties` jvmargs to `-Xmx8192m -XX:MaxMetaspaceSize=2048m` (KSP/lint Metaspace OOM) and set `lint { checkReleaseBuilds false }` in `android/app/build.gradle`. Release uses the debug keystore → standalone signed APK, no custom keystore. After prebuild, re-add `android:usesCleartextTraffic="true"` to `<application>` in the manifest.

### Rebuild CLI (after CLI changes)
```bash
pnpm -C ~/projects/omp-happy/packages/happy-cli build   # → dist/
~/omp-happy-daemon.sh restart                            # so spawned sessions use new code
```
CLI-only changes (e.g. plan/todos, usage/cost, anything reusing existing app rendering) need **no APK rebuild** — just rebuild CLI + restart daemon + start a fresh omp session.

---

## Key gotchas learned
- Clone was **shallow** → first `git push` to the new repo failed ("did not receive expected object"); fixed with `git fetch --unshallow upstream`.
- A bare `happy acp --help` test (no `HAPPY_HOME_DIR`) created one throwaway errored session on the REAL account — harmless, but the reason the launcher pins the env.
- Daemon spawn only restarts on a CLI **version** change; same-version → must `daemon stop` then `start` to load new code.
- omp on PATH: daemon needs `~/.local/bin` on PATH or `omp acp` is ENOENT.

## Helpers (in ~)
- `~/omp-happy-run.sh` — foreground omp session (auth + run).
- `~/omp-happy-daemon.sh` — daemon start/stop/status/restart for remote spawn.

Memory: `[[omp-happy-fork]]`. Related: `[[omp-acp-event-shapes]]`, `[[omp-bridge-systemd]]`.

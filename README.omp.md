# omp-happy

A fork of [slopus/happy](https://github.com/slopus/happy) that drives **[omp](https://github.com/) (oh-my-pi)** as a **first-class agent** — used from your phone over Happy's end-to-end-encrypted relay, with the same UX as the Claude/Codex flow: live remote sessions, spawn-from-phone, streaming reasoning, todos, subagents, and usage/cost.

> Upstream Happy is a mobile/web client for Claude Code & Codex. This fork adds omp as a fully-rendered agent rather than a generic ACP passthrough. See the original [`README.md`](README.md) for the base project.

## Why a fork (not just `happy acp omp`)

Registering omp as a *generic* ACP agent gives a degraded experience, because Happy renders by **tool name** and `metadata.flavor`, and — critically — its **session-protocol path hardcodes tool results to `null`**, so tool outputs never render. Gemini avoids this with a dedicated runner that emits the richer `type:'acp'` data path (`sendAgentMessage`), where outputs land in `tool.result`.

This fork puts omp on that same rich path and adds omp-specific rendering. See [`docs`/`~/omp-happy-build-spec.md`] and the session writeup for the full analysis.

## What this fork adds

| Area | Change |
|---|---|
| **Agent backend** | omp registered as an ACP agent; its messages routed through the rich `sendAgentMessage('omp', …)` path so tool **results** (and structured payloads) actually render |
| **Subagents** | `delegate_task` runs render in a dedicated `DelegateView` — per-agent status, role, tokens/cost/duration, live progress, final output |
| **Tool kinds** | omp's `read/edit/execute/search/fetch/think` reuse existing tool views; `delegate_task`/`fetch` added |
| **Remote spawn** | the daemon can launch omp sessions, so the phone's **＋ New session → omp** works like Claude/Codex |
| **Reasoning** | omp's streaming reasoning (`agent_thought_chunk`) renders as a muted "Reasoning" block (upstream hid all thinking). Toggle in Settings → Appearance |
| **Plan / todos** | omp's ACP `plan` updates render as a live to-do checklist (via the existing TodoView) |
| **Usage / cost** | a compact `📊 used/size tokens · $cost` line per turn |
| **Model shortlist** | a Settings → Models page to curate which of omp's (40+) models appear in the picker |
| **Branding** | app renamed **OMP**, distinct bundle id (`gg.omp.companion`) so it installs alongside real Happy |

## Layout

Monorepo (pnpm workspaces). The omp work lives almost entirely in:
- `packages/happy-cli/src/agent/acp/*` — the omp ACP backend + Path-B sink (`runAcp.ts`)
- `packages/happy-cli/src/daemon/*` — remote spawn of omp
- `packages/happy-app/sources/components/tools/views/DelegateView.tsx`, `sources/sync/typesRaw.ts`, `sources/app/(app)/settings/models.tsx`, `sources/components/{AgentInput,MessageView}.tsx` — rendering

Server (`packages/happy-server`) and the wire/crypto are **unchanged** — both forks ride the same relay (it's agent-blind).

## Quick start

```bash
pnpm install

# CLI
pnpm -C packages/happy-cli build

# Prepare for remote use (registers this machine so the phone can spawn omp):
HAPPY_HOME_DIR=~/.omp-happy node packages/happy-cli/bin/happy.mjs daemon start

# One foreground session (also handles first-run pairing — scan the QR with the app):
HAPPY_HOME_DIR=~/.omp-happy node packages/happy-cli/bin/happy.mjs acp omp
```

omp manages its own provider credentials (under `~/.omp`); configure those with regular `omp`.

### Build the Android app

```bash
cd packages/happy-app
npx expo prebuild --platform android --no-install
cd android
EXPO_PUBLIC_HAPPY_SERVER_URL=<your-happy-server-url> ./gradlew assembleRelease --no-daemon
adb install -r app/build/outputs/apk/release/app-release.apk
```

Notes: release uses the debug keystore (standalone signed APK, no custom keystore needed). For a plain-HTTP / LAN server, add `android:usesCleartextTraffic="true"` to the `<application>` tag and bump `android/gradle.properties` jvmargs (`-Xmx8192m -XX:MaxMetaspaceSize=2048m`) + `lint { checkReleaseBuilds false }` to avoid KSP/lint OOM.

## Isolation

The fork is fully isolated from a real Happy install: all identity/state derives from `HAPPY_HOME_DIR` (default `~/.happy`; set it to `~/.omp-happy`). Different account, different app package — your real Happy is untouched.

## Status / not done

- **Advisor notes** aren't badged separately — omp's ACP strips model-role tags, so they arrive inline (visible within the reasoning stream, not a dedicated panel).
- **Standalone `/jobs` panel** — jobs already show inside `DelegateView`; a separate panel isn't built.

## Credits

Built on [slopus/happy](https://github.com/slopus/happy) (see [`README.md`](README.md) and `LICENSE`). Fork changes generated with Claude Code via Happy.

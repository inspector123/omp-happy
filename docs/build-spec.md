# omp-happy — Build Spec (a Happy clone, omp as the agent)

> Goal: drive **omp** (oh-my-pi) from your phone — see session progress live,
> intervene, and hand a session back and forth between **local** (at the
> computer) and **remote** (from the phone) control.
>
> This is an implementation blueprint for an agent (Qwen) to build later.
> Companion doc: **`~/happy-system-map.md`** — read it first; it is the
> reference for every "how Happy does X" detail referenced below. Happy clone
> source to copy from: `/tmp/happy-clone` (slopus/happy).

---

## 0. TL;DR decision

**Don't build from scratch. Fork Happy and swap the agent layer for omp.**

Happy is already the exact system you want (E2E relay + seq-ordered sync +
RPC-over-rooms + phone client + local/remote handoff). ~90% is agent-agnostic
and reusable verbatim. The only real work is the **agent backend for omp** and
the **local↔remote handoff for omp** (Happy only wired that handoff for Claude
Code; for generic ACP agents it does remote-only).

Two sub-options:
- **B1 (recommended):** Fork Happy. Reuse `happy-server`, `happy-app`,
  `happy-wire`, and most of `happy-cli` unchanged. Add an **omp local-mode** to
  the ACP runner. Net new code lives almost entirely in `happy-cli`.
- **B2:** Use stock Happy *today* with `happy acp -- omp acp` — you get phone
  visibility + remote control immediately, but **no live local handoff**. Good
  as a stopgap / proof-of-life before building B1.

---

## 1. Architecture (unchanged from Happy)

Three actors + a blind relay. See `~/happy-system-map.md` §1–§6 for full detail.

```
  PHONE/WEB  ◄──Socket.IO/E2E──►  RELAY (Fastify+PG+Socket.IO)  ◄──Socket.IO/E2E──►  COMPUTER
  happy-app                        happy-server                       happy-cli + daemon
  (reuse as-is)                    (reuse as-is)                       (omp backend = NEW)
                                                                            │
                                                                       spawns: omp acp
```

What you reuse **verbatim**:
- **happy-server** — seq-ordered encrypted relay, rooms, RPC, presence, auth. No omp knowledge needed; it only routes ciphertext + metadata. (`~/happy-system-map.md` §3, §3b.)
- **happy-app** — the phone/web client. It renders the generic session-protocol message stream, permission prompts, tool calls. omp output just needs to map into that protocol. Minor branding only.
- **happy-wire** — the shared envelope/message schemas. Reuse; extend only if omp needs new event kinds.
- **happy-cli** plumbing — auth, daemon, control server, encryption, `ApiSessionClient`/`ApiMachineClient`, RPC handlers. Reuse.

What you **build/modify** (all in `happy-cli`):
- An **omp agent backend** (`AgentBackend` impl) driving `omp acp`.
- The **local↔remote handoff** for omp.

---

## 2. The omp agent layer (NEW — the core of the work)

### 2.1 What `omp acp` gives you
- `omp acp` = headless ACP (Agent Client Protocol) server over **stdio**, JSON-RPC 2.0. (Confirmed: `omp acp --help` works.)
- It speaks the same ACP surface the omp-android bridge already uses:
  `initialize`, `session/new`, `session/load`, `session/prompt`,
  `session/cancel`, `session/set_config_option`, `_session/truncate`,
  `session/update` (stream: agent_message_chunk, agent_thought_chunk,
  tool_call, tool_call_update, usage_update, config_option_update,
  available_commands_update), `session/request_permission`.
- Slash commands already work over ACP: send `/name args` as a normal
  `session/prompt`; omp dispatches server-side and emits
  `available_commands_update` for discovery. (See omp-android work — same path.)

### 2.2 Backend implementation
Implement Happy's `AgentBackend` interface
(`/tmp/happy-clone/packages/happy-cli/src/agent/core/AgentBackend.ts`) for omp.
Happy **already has a generic ACP backend** to start from:
- `/tmp/happy-clone/packages/happy-cli/src/agent/acp/AcpBackend.ts`
- `…/agent/acp/createAcpBackend.ts`, `runAcp.ts`, `AcpSessionManager.ts`,
  `sessionUpdateHandlers.ts`, `acpAgentConfig.ts`

**Step 1 (cheap):** register omp as an ACP agent config so `happy acp -- omp acp`
spawns it. This is mostly config (`acpAgentConfig.ts`). This is option B2.

**Step 2:** map ACP `session/update` chunks → Happy **session-protocol**
envelopes (`docs/session-protocol.md`): text→`text`, thought→`text`(thinking),
tool_call→`tool-call-start`, tool_call_update→`tool-call-end`,
usage_update→usage ephemeral, request_permission→permission request in
`agentState`. The existing `sessionUpdateHandlers.ts` already does most of this
for generic ACP — verify it covers omp's chunk kinds (it should; omp's ACP ≈
the ACP spec).

### 2.3 Permissions
omp emits `session/request_permission` over ACP. Route it through Happy's
existing permission path: surface in encrypted `agentState.requests` → phone
shows dialog → `update-state` round-trips the choice → backend answers the ACP
permission request. (`~/happy-system-map.md` §4 "Permissions";
`docs/permission-resolution.md`.) The ACP backend already has an
`AcpPermissionHandler` — reuse it.

---

## 3. The local↔remote handoff for omp (NEW — the hard/important part)

This is what stock Happy does **only for Claude** (`runClaude.ts:365`
`currentRunMode: 'local'|'remote'`, `claudeLocal.ts`, the remote scanner). You
must design the omp equivalent. Note: omp differs from Claude — `omp acp` is
headless stdio, and omp's interactive UI is a *separate* TUI (`omp`), not a
JSONL transcript you can tail. So copy the *concept*, not the mechanism.

### 3.1 Recommended model: single ACP session, two attachable controllers
Make **one `omp acp` process the source of truth** for a session. Both a local
controller and the phone attach to it; "mode" = who currently holds input.

- **Always-on mirroring (visibility):** the omp backend always forwards every
  `session/update` to the relay, encrypted. ⇒ the phone **always** sees live
  progress regardless of mode. (This is strictly better than Happy's toggle.)
- **Input from either side:** prompts may originate from the phone (via relay →
  backend → `session/prompt`) **or** from a local controller. Because omp
  dispatches a single ACP session, interleaving is safe — no hard lock needed.
- **Mode flag is advisory UX:** keep a `controlMode: 'local' | 'remote'` on the
  session metadata (encrypted), mirroring Happy's `currentRunMode`/
  `controlledByUser`. It drives UI hints and where permission prompts are routed
  by default, **not** a hard transport switch. Toggle it from either side; sync
  via `update-metadata` (CAS, `expectedVersion`).

### 3.2 What "local controller" means for omp (pick one)
- **Option L1 (simplest, recommended):** a thin local **ACP-client TUI** in
  `happy-cli` that attaches to the same `omp acp` process over stdio and renders
  the stream + lets you type. `happy omp` launches: spawn `omp acp`, start the
  backend (mirrors to relay), AND attach this local TUI. You are "local"; phone
  is mirrored; either can drive. Walk away → drive from phone (remote); come
  back → keep typing locally. No explicit switch needed, but expose
  `/local` `/remote` to set the advisory flag + route permission prompts.
- **Option L2 (more work):** integrate omp's existing native TUI as the local
  view by having it connect to the shared session. Only do this if omp supports
  multiple clients on one session; otherwise L1.

### 3.3 Remote spawn (away-from-computer)
Reuse Happy's daemon path verbatim: phone → `rpc-call spawn-session` → daemon
control server spawns `omp acp` headless (no local TUI), `controlMode:'remote'`.
(`~/happy-system-map.md` §3b "RPC", §4 "Daemon".) When you return to the
computer, attach the local TUI to the running session (resume) and flip the flag
to `local`.

### 3.4 Resume / fork
omp ACP supports `session/load` and `_session/truncate` (rewind). Map Happy's
resume/fork onto these. Persist `ompSessionId` in the encrypted session
metadata so either side can reattach.

---

## 4. Component checklist (what to touch)

| Component | Action | Where |
|---|---|---|
| happy-server | **Reuse as-is** | `/tmp/happy-clone/packages/happy-server` |
| happy-app | Reuse; rebrand; verify it renders omp's tool kinds | `…/packages/happy-app` |
| happy-wire | Reuse; extend only if new event kinds needed | `…/packages/happy-wire` |
| happy-cli: auth/daemon/control/encryption/api | **Reuse as-is** | `…/packages/happy-cli/src/{auth,daemon,api}` |
| **omp ACP backend** | Build (start from generic ACP backend) | `…/packages/happy-cli/src/agent/acp/*` + new `omp/` |
| **omp agent config** | Add (B2 stopgap) | `…/agent/acp/acpAgentConfig.ts` |
| **local↔remote handoff** | Build (§3) | new in `happy-cli/src/omp/runOmp.ts` (model on `runClaude.ts`) |
| **local ACP-client TUI** | Build (Option L1) | new in `happy-cli/src/omp/localTui.ts` |
| Permission routing | Reuse `AcpPermissionHandler` | `…/agent/acp/` |
| Slash commands | Free via ACP prompt dispatch | n/a |

---

## 5. Concrete task list for Qwen

1. **Stand up the relay + app locally.** `pnpm` install the monorepo; run
   `happy-server` (Postgres + Redis) and `happy-app` (web). Pair a device.
   (`docs/dev-environments.md`, `docs/deployment.md`.) Verify with stock Claude
   that phone↔relay↔cli works end to end.
2. **B2 stopgap:** wire `happy acp -- omp acp` via `acpAgentConfig.ts`. Confirm
   on the phone: omp session is visible, prompts work, tool calls + permission
   prompts render. This validates the whole pipe before custom work.
3. **omp backend hardening:** confirm `sessionUpdateHandlers.ts` maps every omp
   `session/update` chunk kind into the session protocol; fix gaps
   (thought chunks, usage, config_option_update, available_commands_update).
4. **Always-on mirroring:** ensure the backend forwards updates to the relay
   even when a local controller is attached (decouple mirroring from input
   ownership).
5. **Local TUI (Option L1):** build `happy omp` = spawn `omp acp` + backend +
   attach a local ACP-client TUI sharing the same session.
6. **Mode flag + handoff:** add `controlMode` to encrypted session metadata;
   `/local` `/remote` toggles; sync via `update-metadata`; route permission
   prompts to the active controller. Model the lifecycle on
   `runClaude.ts:365` + `controlledByUser`.
7. **Remote spawn + resume:** wire phone `spawn-session` RPC to launch headless
   `omp acp`; on return, attach local TUI via `session/load` and flip to local.
8. **Rebrand happy-app** (optional): name/logo; restrict model picker to omp's
   models (you already do this in omp-android `ChatViewModel.restrictModelOptions`).

---

## 6. Key reference pointers

- **Reference architecture (read first):** `~/happy-system-map.md` (full system
  + server internals).
- **Happy source to fork:** `/tmp/happy-clone` (re-clone: `git clone
  https://github.com/slopus/happy`).
- **Agent backend interface:** `packages/happy-cli/src/agent/core/AgentBackend.ts`
- **Generic ACP backend (your starting point):**
  `packages/happy-cli/src/agent/acp/{AcpBackend,createAcpBackend,runAcp,AcpSessionManager,sessionUpdateHandlers,acpAgentConfig}.ts`
- **Local/remote handoff to copy (Claude version):**
  `packages/happy-cli/src/claude/{runClaude.ts,claudeLocal.ts}` — esp.
  `runClaude.ts:365` (`currentRunMode`), `:423` (remote scanner), `:505`
  (`controlledByUser`).
- **Session protocol:** `docs/session-protocol.md`, `docs/session-protocol-claude.md`
- **Permissions:** `docs/permission-resolution.md`
- **omp ACP surface:** identical to what omp-android already drives — see
  `~/projects/omp-android/bridge/server.mjs` + `ChatViewModel.kt` for a working
  ACP client reference (initialize, session/*, update chunk kinds,
  request_permission, _session/truncate).

---

## 6b. omp-unique feature backlog (the "first-class, not grafted" work)

> Investigation finding (2026-06-27): registering `omp acp` as a *generic* ACP
> agent yields the **Gemini-or-worse** experience, because Happy's good UX is
> not a property of ACP — it's a property of a **tool-name-aware + `metadata.flavor`-aware**
> rendering stack that Claude (and partially Codex/Gemini) get and generic ACP
> doesn't. Two layers degrade:
> - **happy-cli** `agent/acp/{AcpSessionManager,sessionUpdateHandlers}.ts` flatten
>   ACP updates: tool name → `'unknown'`/raw kind, thinking → fragile regex,
>   no subagents, no message UUIDs, no diff/`locations`, **drops `rawInput`/`rawOutput.details`**.
> - **happy-app** renders by **tool name** (`components/tools/{views/_all,knownTools}.tsx`)
>   and by **`metadata.flavor`** (`modelModeOptions.ts`, `PermissionFooter.tsx`,
>   `MessageView.tsx`). Unknown name → raw JSON (`ToolView.tsx:276-293`); unknown
>   flavor → empty/generic pickers.
>
> **Good news from live `omp acp` capture:** omp's wire format is already RICH —
> tool_call carries `kind` (ACP-standard: read/edit/execute/search/fetch/think/other),
> a human `title`, `rawInput`, `rawOutput`, file `locations`; chunks carry a
> `messageId` (→ rewind/fork id); `usage_update` carries `cost`;
> `available_commands_update` streams all 25+ omp commands; `configOptions`
> carries dynamic `mode` + `model` selects. The richness is **on the wire** — the
> loss is happy-cli dropping it. omp's `kind` strings reuse Gemini's existing
> `knownTools` entries (`edit`/`execute`) for free.

### DECISIVE routing finding (2026-06-27) — two send paths, only one carries results

Tracing how a tool RESULT reaches the app revealed **two parallel delivery paths**, and the generic ACP backend is on the wrong one:

- **Path A — session-protocol** (`type:'session'` / `sessionEnvelope`). Used by
  `runAcp.ts` (generic ACP, where omp was registered), `runOpenClaw`, `runCodex`
  via `session.sendSessionProtocolMessage()` → `AcpSessionManager` envelopes.
  **The app's normalizer hardcodes the tool result to `null`** at `tool-call-end`
  (`happy-app/sources/sync/typesRaw.ts` ~line 666: `content: null, is_error:false`).
  ⇒ **Path A can NEVER populate `tool.result`.** Results can only leak through as a
  separate `text`(thinking) bubble (what Codex does). No structured result object.
- **Path B — unified ACP data** (`type:'acp'`, `provider`, `data:{type:'tool-result',
  callId, output, isError}`). Used by **Gemini's dedicated `runGemini.ts`** via
  `session.sendAgentMessage('gemini', …)`. The `output` lands in `tool.result` →
  rich `ToolView` INPUT/OUTPUT + (for omp) the structured `rawOutput.details` the
  delegate renderer needs. **Provider enum is closed**: `['gemini','codex','claude','opencode']`
  (`typesRaw.ts:319`, CLI `MobileAgentType` / `sendAgentMessage` sig) — **omp must be added**.

⇒ **First-class omp REQUIRES Path B.** Cleanest impl: omp keeps `runAcp`'s transport/
prompt-loop/permissions/modes/slash infra but **swaps the sink** — emit each backend
`AgentMessage` via `sendAgentMessage('omp', …)` (map to the `acp` data shapes, exact
field names per `runGemini.ts` tool-call/tool-result), and use `task_started`/
`task_complete` for turn lifecycle instead of `startTurn`/`endTurn` envelopes.
`MessageAdapter.ts` is NOT a shortcut — its field names (`toolResult`/`toolArgs`)
don't match the app schema (`output`/`input`); runGemini's inline shapes are canonical.

DONE so far (CLI, path-agnostic, needed either way): transport now reads
`update.rawOutput ?? update.content` for results (`sessionUpdateHandlers.ts`), and
forwards real `title` + `rawInput` args + `delegate_task` name detection.
REMAINING to finish CLI half: add `omp` to the 3 enums + the sink swap + mapper.
(Needs `pnpm install` + `typecheck` to verify — cross-package.)

### Three-tier piping model

- **Tier 1 — free via ACP discovery (zero code):** `available_commands_update` →
  populates the app slash-command menu automatically; `configOptions` → populate
  mode/model pickers *once* flavor `omp` reads them instead of hardcoding.
- **Tier 2 — CLI mapping fixes (prerequisite; data must survive the handler):**
  forward `rawInput`, `rawOutput` (incl `details.progress[]`/`results[]`), `title`,
  `kind`→name, `locations`, `messageId`→rewind id, `agent_thought_chunk`→thinking.
  If dropped at the CLI, the app can never render it. Files:
  `agent/acp/{sessionUpdateHandlers,AcpSessionManager}.ts`.
- **Tier 3 — app custom renderers (bespoke):** `flavor:'omp'` wiring + per-feature
  views below.

### Feature backlog (priority order)

| # | omp feature | Gap in Happy today | Tier-2 (CLI) | Tier-3 (app) |
|---|---|---|---|---|
| **1** | **`delegate_task` subagents** (the flagship). One `tool_call` kind=`other`, `rawInput={agent,context,tasks:[{id,description,role,assignment}]}`; live per-agent state in `tool_call_update`→`rawOutput.details.progress[]`→`results[]` (output,exitCode,aborted,durationMs,tokens). **Structurally different from Claude subagents** (which are separate linked sub-sessions) — cannot reuse Happy's Task grouping. | Generic → multi-KB JSON args + frozen "Running 3 agents". | Preserve `rawOutput.details.progress/results`. | New `delegate_task` tool view; **port omp-android `DelegateBody`/`AgentRow`** (`~/projects/omp-android/android/.../ui/ToolViews.kt`): merge progress/results by task id, per-agent status chip + metrics + live `lastIntent` + final report. |
| 2 | **Modes** Default / Plan (`configOptions.mode`; plan=read-only→markdown) | hardcoded per-flavor modes | — | flavor `omp` permission-modes from `configOptions.mode` |
| 3 | **Dynamic model list** (`configOptions.model`, 40+) + `/fast`, `--smol/--slow/--plan` tiers | Claude/Codex models hardcoded in `modelModeOptions.ts` | — | flavor `omp` reads models from session-metadata configOptions |
| 4 | **Thinking levels** minimal→xhigh (`--thinking`) | maps to Claude "effort" | forward thought chunks | flavor `omp` effort levels |
| 5 | **Tool kinds** read/edit/execute/search/fetch/think + named (`browser_*`,`web_*`) | unknown names → raw JSON | forward `kind`+`title`+`locations` | `knownTools` entries for omp kinds (reuse Gemini `edit`/`execute`; add read/search/fetch/think + browser) |
| 6 | **Advisor** (passive per-turn reviewer injecting notes) | no concept | advisor notes → `service`/thinking events | optional advisor banner; `/advisor` toggle free (tier 1) |
| 7 | **Background jobs** (`/jobs`), **context/usage** (`/context`,`/usage`,`usage_update.cost`) | tokens only, no cost/jobs | forward `usage_update.cost` | usage/jobs/context panels |
| 8 | **Native session list/fork/resume/close** (`sessionCapabilities`) | Claude fakes resume via JSONL tail | map resume/fork onto ACP `session/load`+`fork` | — (cleaner than Claude path) |
| 9 | compact/shake, skills/rules/hooks, marketplace plugins, share/export, browser headless toggle | no concept | — | mostly free via slash-command menu (tier 1) |

### Concurrency caveat (shapes §3 handoff)
A single `omp acp` process **serializes all turns**; a `delegate_task` holds the
turn for *minutes* — any concurrent prompt gets `"Agent is already processing.
Use steer()…"`. ⇒ one session = one process is fine; **multi-session needs one
`omp acp` process per active session**, plus an "agent busy" UI state. (Source:
`~/session_docs/2026-06-27-omp-android-subagent-fixes.md` finding #2.)

---

## 7. Reality check

- ~90% reuse. The genuinely new code is small: an omp ACP backend (mostly
  config + chunk mapping the generic backend nearly covers) and the
  local-handoff TUI/flag. The hard *design* question — "what is local mode for a
  headless ACP agent" — is answered in §3.1/§3.2 (single session, two
  controllers, always-on mirror, advisory flag).
- omp-android (your existing app) is **not** needed for this — happy-app
  replaces it. Keep omp-android only if you want a separate lighter client; the
  ACP-client knowledge there (chunk decoding, truncate, permissions) is a useful
  crib for the local TUI in step 5.
- B2 first. Get omp visible on the phone via stock Happy before building B1 —
  it de-risks everything and might even be enough.
</content>

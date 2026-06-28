# omp-happy — features, fixes & diagnostics (continuation)

- **Date:** 2026-06-28
- **Session ID:** 7dba7bfe-40fb-4f22-a3a4-302e095978d1
- **Repo:** `~/projects/omp-happy` → github.com/inspector123/omp-happy (private, branch `omp-backend`, 16 commits)
- **Prior doc:** `~/session_docs/2026-06-27-omp-happy-fork.md` (the initial fork + Path-A/B finding). This doc covers everything built/diagnosed after that.

The fork drives **omp (oh-my-pi)** as a first-class agent in a Happy clone (phone over E2E relay). Foundational architecture (Path A session-protocol vs Path B `sendAgentMessage`, why generic ACP = Gemini-or-worse) is in the prior doc; not repeated here.

---

## Features added (each shipped + committed)

| Commit | What |
|---|---|
| `663a415a` | **Curated model shortlist** — Settings→Models page + "Manage models…" link in the composer gear; `modelShortlist` setting filters the picker (omp advertises 40+ models, which overflowed the overlay and hid the Default/Plan modes above). `c2c2f244` adds a Settings→Features entry (works without a session via `useLatestSessionWithModels`). |
| `be37e073` | **Reasoning blocks** — upstream Happy hard-hid every `isThinking` message (`MessageView` `return null`). omp streams real reasoning (`agent_thought_chunk`, verified 89 frames/turn); now rendered as a muted "Reasoning" block. Toggle: Settings→Appearance→"Show reasoning". |
| `0cb59792` | **Coalesce reasoning chunks** — omp streams ~hundreds of token-sized thought chunks; each was becoming its OWN "Reasoning" block. Now accumulate by kind (output vs thinking) and flush each contiguous run as one message (`emitOmpMobile`/`flushOmpText` in runAcp). |
| `145e1708` | **Plan/todos + usage/cost** — omp's ACP `plan` update (entries, dropped because `handlePlanUpdate` only checked `update.plan`) → synthesized **TodoWrite** so the existing TodoView renders it. `usage_update` (dropped at backend) → `📊 used/size tokens · $cost` line. Both CLI-only (reuse app rendering). |
| `0eaba79a` | **Local interactive mode** — `happy acp omp --local`: read prompts from the terminal too + render the stream cleanly (dimmed reasoning, tool lines, `omp›` prompt), while still mirroring to the phone. runAcp was remote-only (`session.onUserMessage`). The "happy wraps claude" experience, for omp. Launcher passes `--local`. |
| `e093ac79` | **Repo helper scripts** — `scripts/omp-run.sh` (interactive local session) + `scripts/omp-daemon.sh` (remote-spawn daemon); path-portable, isolated `HAPPY_HOME_DIR`, env-overridable server. |
| `39ee40cf` | **Yolo / allow-all permissions** — omp emits `session/request_permission`, routed to the phone, so it kept asking. `--yolo` (+ bypass-style modes) auto-approves ACP permission requests (`approved_for_session`). Wired into the launcher AND daemon spawn so omp is allow-all locally and phone-spawned. |
| `8f826021` | **Model-default leak fix** — new omp sessions showed "opus 4.8". omp wasn't a known agent key so `getCodeAgentDefaults`/`getHardcodedModelModes` fell back to Claude. Special-cased omp → "default model" + default permission mode. |
| `56f50181` | **Resume omp sessions** — see below. |

(Earlier in the same session: `e981994e` Path-B backend, `7dbda478` first-class rendering/DelegateView, `22a27f16` rebrand, `9582adb8` remote spawn — covered in the prior doc.)

---

## omp session resume (`56f50181`) — the big one

**Mechanism proven first:** ACP `session/load` (omp advertises `loadSession:true`) restores full context — test planted "BANANA42", resumed via `session/load`, omp recalled it. NOTE the `--resume` CLI flag does NOT work over ACP (session/new overrides it); must use the `session/load` protocol method. omp also auto-switches out of `~` to a temp dir unless `--allow-home` (that's why the first test failed — mismatched projects).

**Wiring (mirrors Claude/Codex resume):**
- `AcpBackend.startSession`: `connection.loadSession({sessionId, cwd, mcpServers})` when `resumeSessionId` set, else `newSession`. `getAgentSessionId()` exposes the omp id.
- `runAcp`: persist `ompSessionId` + `flavor:'omp'` in Happy session metadata; accept `--resume-omp <id>` / `HAPPY_RESUME_OMP_SESSION_ID`.
- `acpAgentConfig`: omp now launches `omp --allow-home acp`.
- daemon `buildResumeLaunch`: omp branch → `happy acp omp --resume-omp <id> --yolo`; `resumeOmpSessionId` env on spawn.
- app: `ompSessionId` metadata field, resume eligibility (`hasBackendResumeId += ompSessionId`), `resumeOmpSessionId` spawn option.

**To use:** the in-app **Resume** action (session info screen) now works for omp — but it's gated by **Settings→Features→"Resume sessions" (experimental)**. Dead sessions also recoverable directly: `happy acp omp --resume-omp <id>` (or native `omp --resume <id>`).

---

## Diagnostics / findings (no code, but important)

- **"Session died on me" = a real bug, fixed (`fc44d5cb`).** An abort/cancel made omp report a `stopped` backend status; runAcp treated ANY `stopped` as fatal → killed the runner → which stamped the session `archived` ("Session ended"). So a stray abort (e.g. on a transient reconnect — NOT a lid close; "lid open" is just Happy's canned reconnect string) silently killed an active session. Fix: an `aborting` flag — a `stopped` during a user abort ends only the current turn, session stays alive. (Secondary, not done: omp path lacks Claude's un-archive-on-reconnect.)
- **"Seems stuck" was usually NOT stuck** — the session was doing a long real task (reading cja backend / tvp.py, codex `store:false` work) with normal read/search/execute tools, **no `delegate_task` subagent**. Also a related UX bug: omp pauses >0.5s between reasoning chunks → the backend's idle detector fires `task_complete` mid-thought (premature turn-end). Worth fixing later (use omp's real `stopReason`, not the 0.5s idle heuristic). Plus ~5 stale Jun-27 omp processes were piled up (one looping `git rev-parse` from the app's git-status poll on a non-git cwd) — clean those up.
- **Advisor (PARKED):** active but invisible — omp injects advisor notes into its CONTEXT (side-channel for the model), not as streamed agent output, AND ACP strips model-role tags. Leads: `/advisor dump [raw]` command; check session JSONL for an advisor role; multi-turn `/advisor on` capture.
- **"Be in a real omp session, Happy mirrors on top" (PARKED):** omp has NO multi-client live server — only `omp acp` (stdio, one client). Sessions persist as Claude-style JSONL per cwd (`~/.omp/agent/sessions/<cwd>/<id>.jsonl`) but written only at turn END (not live per-token). So native-TUI + live-phone mirror isn't fully possible; for LIVE mirroring ACP is the best omp offers. `--local` already gives "be in omp + Happy on top" via the acp session.
- **Transports:** Happy does NOT use ACP for Claude (own SDK) or Codex (app-server WebSocket); ACP is only Gemini/omp/opencode. User's take: WebSocket worst, ACP middle, native best — tracks with how bespoke each integration is.

---

## Operational notes
- **Servers (split):** CLI/daemon → LAN `http://192.168.0.252:30003`; APP → external `http://50.47.26.175:30003` (baked at build via `EXPO_PUBLIC_HAPPY_SERVER_URL`, needs `usesCleartextTraffic`). Same physical server; QR carries only the keypair.
- **Build/deploy:** APK = `EXPO_PUBLIC_HAPPY_SERVER_URL=http://50.47.26.175:30003 ANDROID_HOME=~/Android/Sdk ./gradlew assembleRelease --no-daemon` then `adb install -r`. Gradle gotchas: `android/gradle.properties` jvmargs `-Xmx8192m -XX:MaxMetaspaceSize=2048m`, `lint{checkReleaseBuilds false}`, re-add manifest `usesCleartextTraffic="true"` after any prebuild. CLI-only changes (reasoning/plan/usage/yolo/abort-fix/resume-engine) need NO APK — `pnpm -C packages/happy-cli build` + `scripts/omp-daemon.sh restart` + a fresh session.
- **Helpers:** `~/omp-happy-run.sh` & `~/omp-happy-daemon.sh` (home), mirrored to `scripts/` in the repo.

## Open / next
- Install the latest APK once the phone is back on adb (build SUCCESSFUL, code committed; phone dropped off wireless adb at end of session). It carries the model-default fix + resume app pieces.
- Premature turn-end (idle heuristic) fix; un-archive-on-reconnect parity; advisor surfacing; clean stale processes.

Memory: `[[omp-happy-fork]]`.

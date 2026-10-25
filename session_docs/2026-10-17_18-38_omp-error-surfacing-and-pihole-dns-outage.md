# Handoff: omp error surfacing in the Happy app + Pi-hole DNS outage

Date: 2026-10-17 (evening, machine timezone PDT)
Project: ~/projects/omp-happy

## Workstream 1: surface omp errors in the mobile app

### Problem

Two classes of session events visible in the omp TUI never reached the Happy phone app:

1. Assistant turns that ended in a provider error (`stopReason: "error"`, empty `content`, `errorMessage` set, e.g. "Connection error."). The CLI's text mirroring (`mirrorEndedAssistantText` in `runOmp.ts`) extracts text content only, so these turns produced nothing.
2. Background job completion notices. omp appends `custom_message` entries with `customType: "async-result"` straight to the session (via `appendCustomMessageEntry`) without emitting any extension event, so the happy bridge extension never saw them. The TUI renders these as "Background job completed [task] CurveFitMap (23m34s)" lines.

Reference session with both: `~/.omp/agent/sessions/-/2026-10-15T16-48-47-118Z_01a14077-5e0e-743b-82c0-9abdba552063.jsonl`.

### Changes (all in packages/ under ~/projects/omp-happy)

happy-cli:

- `scripts/omp-happy-bridge.mjs`: new session-entry poll. Every 2s (`ctx.setInterval`, with a raw unref'd `setInterval` fallback for older omp) it reads `ctx.sessionManager.getEntries()` and forwards new `custom_message` entries with `customType: "async-result"` to the CLI as `agent_event` frames of type `custom_message`. A count cursor skips history on session start/switch. Exported pure helpers `selectNewSessionEntries` and `isForwardedCustomEntry` are unit-tested.
- `src/omp/runOmp.ts`: `MirrorEvent` gained `customType`/`content`/`details`. New `handleBridgeEvent` cases:
  - `message_end` + assistant `stopReason === "error"` + non-empty `errorMessage` sends `{type: "omp-error", message}` (deduped through the existing `endedAssistantMessages` set; `retryRecovery.status === "superseded"` skipped).
  - `custom_message` sends `{type: "omp-jobs", jobs}`. `extractAsyncResultJobs` normalizes `details.jobs` (jobId, type, label, durationMs) and `extractAsyncResultFailures` parses `<task-result id status>` / `<error>` blocks out of the message body to mark failures (error excerpt capped at 600 chars).
- `src/api/apiSession.ts`: `AgentMessageData` gained `omp-error` and `omp-jobs` variants plus the exported `OmpJobNotice` interface.

happy-app:

- `sources/sync/typesRaw.ts`: `ompErrorEventSchema` (`{type: "omp-error", message}`) and `ompJobsEventSchema` (`{type: "omp-jobs", jobs: [jobId, type?, label?, durationMs?, failed?, error?]}`) added to `agentEventSchema` and to the ACP data union; `normalizeRawMessage` maps both to `role: "event"` messages (same pattern as `advisor`).
- `sources/components/MessageView.tsx`: `AgentEventBlock` renders `omp-error` as a red "Error: ..." line and `omp-jobs` as one row per job ("Background job completed/failed [type] jobId (duration)" via `formatWorkDuration`) with the failure excerpt underneath. New styles `ompNotice*`.
- `sources/text/_default.ts` plus all ten files in `sources/text/translations/`: new keys `message.ompError`, `message.ompJobCompleted`, `message.ompJobFailed`.

Naming note that caused confusion: `sendAgentMessage` persists every omp message as `content: {type: "acp", provider: "omp", data}`. That `acp` string is a legacy wire discriminator (see the comment at the top of `apiSession.ts`), not the ACP backend. The transport is the extension socket bridge end to end.

### Verification

- `runOmp.test.ts`: 37/37, including three new tests (error forwarding with replay dedupe, failed-job parsing from a realistic async-result body, non-async custom messages ignored).
- `scripts/omp-happy-bridge.test.ts`: 19/19, including five new tests for the entry cursor and the async-result filter.
- App reducer/types specs: 68/68. Both packages typecheck clean.
- A throwaway socket harness drove the real extension export through a unix socket and proved the poll emits exactly one `custom_message` frame for an appended job while skipping history; harness deleted after use.
- App-side path proven by a temporary spec (wire payload -> `normalizeRawMessage` -> reducer -> `agent-event` message), then removed.

### Deployment state

- happy-cli dist rebuilt (`pnpm test` runs the build). The bridge extension `.mjs` is read from source at every session start, so new sessions pick everything up.
- Phone app rebuilt with `./gradlew assembleRelease` in `packages/happy-app/android` and installed with `adb -t <id> install -r`. Package `gg.omp.companion.dev`, versionName 1.7.0, updated in place. Rotation lock restored (`accelerometer_rotation 0`, `user_rotation 0`, both verified).
- Phone adb: Pixel 9 Pro on 192.168.0.105. Wireless debugging endpoint discovered via `adb mdns services`; pairing with `adb pair <ip>:<pairPort> <code>` (code shown on the phone), then `adb connect <ip>:<port>`.

## Workstream 2: "Connection error." storm on the resumed session

### Symptom

Session `01a14077-5e0e-743b-82c0-9abdba552063` (the Telegram-bridge chat) spammed `Error: Connection error.` and `Error: Retry budget exhausted after 10 retries: Connection error.`.

### Debug path, including the wrong turns

- Anthropic outage hypothesis: refuted. `curl --resolve api.anthropic.com:443:160.79.104.10 https://api.anthropic.com/v1/models` returned HTTP 401 in 124 ms (healthy API rejecting an unauthenticated probe).
- "No internet on this box" hypothesis: partially misleading. IP egress worked (ping 1.1.1.1 at 4 ms, TLS by raw IP worked). Only name resolution was dead.
- Decisive experiment: same-second DNS probes of 192.168.0.10 (the Pi-hole) from two LAN clients. From z.local (192.168.0.252): NOERROR for example.com, api.anthropic.com, google.com. From this workstation (192.168.0.215): REFUSED for the same names in the same second. Responder source IP captured as 192.168.0.10:53 (ttl=0, generated locally by FTL, not forwarded); ARP confirmed the neighbor.
- Root cause found in `/var/log/pihole/FTL.log` on the Pi-hole (SSH access provided by the user in chat; credentials not recorded here): 94 rate-limit events, e.g. `Still rate-limiting 192.168.0.215 as it made additional 2870 queries`. FTL's per-client rate limiter (default 1000 queries/60s) locked out this workstation after a retry storm (every local service retrying DNS at once once resolution began failing) and answered REFUSED to it alone. The lockout self-sustained while the retry loops kept running.
- The user's "static IP setting" lead was the identity link: NetworkManager profile "Wired connection 1" is `ipv4.method manual`, address 192.168.0.215/24, gateway 192.168.0.1, sole DNS 192.168.0.10. The Pi-hole keys clients by IP.

### Fixes applied

1. Runtime fallback on this box: `sudo resolvectl dns enp7s0 192.168.0.10 1.1.1.1` (runtime-only, IP unchanged so the phone-to-server link at http://192.168.0.215:40004 stayed up).
2. Persistent fallback: `nmcli con mod 'Wired connection 1' ipv4.dns "192.168.0.10 1.1.1.1 8.8.8.8"`. Survives reboots; 8.8.8.8 activates on next link activation. systemd-resolved fails over to the next server when the Pi-hole answers REFUSED.
3. Pi-hole root cause: in `/etc/pihole/pihole.toml`, `[dns.rateLimit]` set `count = 0` and `interval = 0` (documented off switch), then `sudo systemctl restart pihole-FTL`. Verified active and persisted.

### Verification

- Direct queries from this workstation to the Pi-hole: NOERROR for example.com, api.anthropic.com, google.com.
- z.local still NOERROR (other clients unaffected throughout).
- The resumed session runs under `happy omp` with the new bridge code; its turn ran 9+ minutes with three subagents and no connection errors.

### Lost work note

The turn that was in flight during the outage hit the retry budget and died. Its prompt ("Verify today's MMT grader changes") was resubmitted via tmux send-keys (Ctrl-C to clear the editor, retype, Enter).

## Current state

- tmux session `omp-01a14077` (zsh, cwd ~) runs `happy.mjs omp -- --extension ~/.omp/agent/extensions/tg_bridge.ts --resume 01a14077-5e0e-743b-82c0-9abdba552063`. The user replaced the initial plain `omp --resume` with this themselves, so both the tg bridge and the happy bridge are attached. The old instance (pid 5271, gnome-terminal) was SIGTERM'd first; two writers on one session file would corrupt it.
- `tg_bridge.ts` auto-loads from `~/.omp/agent/extensions/` regardless of the explicit flag.
- Local happy-server runs at 192.168.0.215:40004 (`packages/happy-server/sources/standalone.ts serve`); the phone connects to it by raw IP.

## Open items

- Rate limiting is disabled for all Pi-hole clients by user decision (`dns.rateLimit.count = 0`, `interval = 0` in `/etc/pihole/pihole.toml`, survives FTL restarts). Verified empirically: a 1200-query burst from this workstation in ~2s returned 1200 NOERROR, zero REFUSED. Do not re-enable a throttle without asking the user.
- The Pi-hole admin UI still lists this client; nothing to do there unless filtering behavior looks wrong.
- IPv6 DNS fallback was not set on the NetworkManager profile (no v6 resolver configured; optional).
- The phone app build is a local release APK, not pushed to any store.

## Gotchas for the next session

- omp never emits a `message_update` carrying an error-type `assistantMessageEvent`. Provider errors surface only as `message_end` with `stopReason: "error"` and empty content. The dead error branch in `handleAssistantMessageUpdate` predates this and stays harmless.
- `ReadonlySessionManager` exposed to extensions has `getEntries()` but no change notification; polling is the only extension-visible signal for custom messages.
- Pi-hole FTL rate-limiting is per-client, answers REFUSED (not SERVFAIL), and logs `Rate-limiting client X` / `Still rate-limiting X as it made additional N queries` / `Ending rate-limitation of X` to `/var/log/pihole/FTL.log`. A DNS-chatty machine stuck in retry loops can hold the lock indefinitely.
- The fastest discriminator for "is it DNS": run the same query against the same resolver from two clients in the same second, and capture `recvfrom`'s source address to rule out interception.
- sudo over the pty prompts in the forwarded terminal; sudo timestamps are per-tty, so each new pty needs the password again.

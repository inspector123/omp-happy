# Session IRC: cross-process, cross-machine, and app inbox

Date: 2026-09-19 14:30
Repository: `/home/zarathustra/projects/omp-happy`
Related prior doc: `2026-09-04_09-15_happy-server-40004-setup-and-authentication.md`

## What this work set out to do

Give two `omp` coding-agent sessions a way to talk to each other as agents, first on one machine and then across machines through the happy server, and surface those messages in the happy app.

The starting point was a question about the built-in coordination tool: `hub` already implements agent-to-agent messaging, so why not use it between separate sessions?

## What was wrong with the built-in path

`hub` messaging is process-global and cannot cross a process boundary.

Evidence, read from the current sources:

- `packages/coding-agent/src/irc/bus.ts` header: "IrcBus - Process-global mailbox bus for agent-to-agent messaging." Its `IrcBus` singleton resolves recipients through `AgentRegistry`.
- `packages/coding-agent/src/registry/agent-registry.ts` header: "Process-global registry of agents (the main session plus every subagent)."
- Delivery ends in `AgentSession.deliverIrcMessage` on an in-process session object. There is no socket, no registry file, and no persistence of the bus.

The same wording is present on `github.com/can1357/oh-my-pi` `main`, so this is current behaviour and not an artifact of the older local checkout (the checkout is v16.5.0 while the installed binary is 18.2.2; the harness docs at `omp://` come from the installed binary).

The only built-in cross-process session channel is `/collab`, which replicates one session to guests over an encrypted relay. A guest can prompt and interrupt the host, but a guest's own session is suspended while joined and a guest cannot be messaged as a peer, so it is session sharing rather than peer messaging.

Other relevant surfaces found while reading: the launch broker under `~/.omp/run/daemons/<project-hash>/` is cross-instance but supervises child processes, `--mode rpc` gives an external process control of one session over stdio, and extensions can open sockets and inject text with `pi.sendUserMessage(...)`, which is the documented seam for pushing an external message into a live session.

## Design

The feature is built from four pieces, each using the smallest existing mechanism that fits.

1. Local transport (per machine). `omp-session-irc.ts` is loaded into every `omp` child the happy CLI spawns. It publishes `~/.omp/run/session-irc/<pid>.json` and listens on `~/.omp/run/session-irc/<pid>.sock` with mode 0600 in a 0700 directory. Frames are newline-delimited JSON: `{ v, id, from, to?, body, ts, replyTo? }`. It registers the `sirc` tool with `op="list"` and `op="send"` (plus `to`, `message`, `replyTo`, `await`).
2. Injection. An inbound frame becomes `pi.sendUserMessage("[irc from ...] ...", { attribution: "agent" })`. An idle session starts a turn; a streaming session receives a steer.
3. Reply relay. When a turn ends, the extension sends the turn's final assistant text back to the sender with `replyTo` set, so a peer answers in plain prose and never has to call a tool itself. An explicit `sirc` reply with the matching `replyTo` discharges the obligation first, so nothing is duplicated.
4. Cross-machine path. The happy server stores the message in the sender's own per-user feed and emits an ephemeral to the target session's room; the target CLI forwards it to its child; a reply travels the same way back. Because the message is a feed item, the app inbox renders it with no new sync machinery.

Wire contract:

```
POST /v1/peer-messages  { id, fromSessionId, fromTitle, toSessionId, body, replyTo? }
  -> { id, delivered }            delivered = a live session-scoped socket existed
GET  /v1/peer-messages?sessionId=&limit=&before=  -> { items, hasMore }

ephemeral event: { type: 'peer-message', id, fromSessionId, fromTitle, toSessionId, body, replyTo, ts }
  emitted with recipientFilter { type: 'all-interested-in-session', sessionId: toSessionId }

feed body: { kind: 'peer_message', ...same fields }

bridge frames child -> CLI: peer_send { requestId, to, body, replyTo? } | peer_roster { requestId }
bridge frames CLI -> child: peer_message | peer_send_result | peer_roster_result
in-process hook: globalThis.__ompHappyPeer { send, roster, onResult, onMessage }
```

Peer handles are `name#pid` locally and `happy:<sessionId>` remotely. Remote titles come from the CLI, which is the only party that can decrypt session metadata (`~/.omp-happy/sessions.json` holds the per-session key); the server never sees a title.

## Why the sender identity is in the request body

The first server stub tried to derive the sender from the authenticated caller. That cannot work: `request.userId` is all the auth layer provides, and session metadata on the server is encrypted, so neither the sender id nor a title is available server-side. The contract now has the CLI send `fromSessionId` and `fromTitle`, and the server verifies the caller owns both session ids. Getting this wrong would have produced unattributed messages in the app inbox.

## Defects found and fixed during review

1. Cold-path replay. The first implementation fetched the newest 200 peer messages whenever a child became ready and forwarded all of them, because the seen-id set is per process. A restarted or resumed session would re-inject old messages and ask the agent to answer them again. Fixed by bounding the catch-up to messages whose `ts` is not older than the CLI process start, with a boundary test. Messages sent while no CLI ran reach the app inbox but are not replayed into the agent.
2. Remote await correlation. For a remote send the CLI assigns the message id (a UUID) and returns it in `peer_send_result.id`. The peer echoes that id in its reply's `replyTo`, so the sender must key its waiter on the returned id rather than a locally generated one. The extension was corrected before the end-to-end run.
3. Missing extension on daemon-spawned sessions. `buildOmpArgs` originally added only the bridge extension, and the session-irc extension was wired through `omp-happy-launcher.sh`. Sessions started from the phone app are spawned by the daemon as `omp --yolo --started-by daemon`, which never runs the launcher, so they had no peer channel. `buildOmpArgs` now adds `omp-session-irc.ts` (when the file sits next to the bridge, and unless `OMP_HAPPY_SESSION_IRC=0`), and the launcher change was reverted so there is one source of truth.

## Files changed

Server, `packages/happy-server`:
- `sources/app/feed/types.ts` (new `peer_message` body variant)
- `sources/app/events/eventRouter.ts` (`peer-message` ephemeral, `hasSessionScopedSocket`)
- `sources/app/api/routes/peerRoutes.ts` (new) and its test
- `sources/app/api/api.ts` (route registration)
- `sources/app/events/eventRouter.spec.ts` (new)

CLI, `packages/happy-cli`:
- `src/api/apiSession.ts` (peer HTTP methods, `ephemeral` subscription, title resolution)
- `src/api/types.ts`, `src/utils/offlineSessionStub.ts`
- `src/omp/runOmp.ts` (frame union, dispatch, catch-up, bundled extension)
- `src/api/apiSession.test.ts`, `src/omp/runOmp.test.ts`

Extensions, `packages/happy-cli/scripts`:
- `omp-session-irc.ts` (new), `omp-session-irc.probe.mjs` (new harness)
- `omp-happy-bridge.mjs` (hook plus new frames)

App, `packages/happy-app`:
- `sources/sync/feedTypes.ts`, `sources/sync/apiTypes.spec.ts` (schema)
- `sources/components/FeedItemCard.tsx` (inbox row)
- `sources/sync/peerMessages.ts` (new helpers) and its spec
- `sources/app/(app)/peers/index.tsx`, `sources/app/(app)/peers/[sessionId].tsx` (new screens)
- `sources/app/(app)/_layout.tsx`, `sources/components/InboxView.tsx` (routes and entry point)
- `sources/text/_default.ts` and the ten locale files (`peers.*` keys)

`README.md` gained a row for the extension in the script table.

## Verification performed

Unit and integration tests:

- `packages/happy-server`: `vitest run sources/app/api/routes/peerRoutes.test.ts sources/app/events/eventRouter.spec.ts` passed, 5 tests. `pnpm typecheck` clean.
- `packages/happy-cli`: `vitest run --project unit src/omp/runOmp.test.ts src/api/apiSession.test.ts` passed, 65 tests. `pnpm typecheck` clean. `pnpm build` succeeded with the daemon briefly stopped, then the daemon was restarted so new sessions use the new `dist`.
- `packages/happy-app`: `vitest run sources/sync/peerMessages.spec.ts` and `sources/sync/apiTypes.spec.ts` passed. `tsc --noEmit` clean, including a route-typed `router.push('/peers')` with no casts after `expo start` regenerated `.expo/types/router.d.ts`. `expo export --platform web` bundled the app successfully with the new screens.
- Extension probe, `bun packages/happy-cli/scripts/omp-session-irc.probe.mjs`: 10/10 checks against real `omp` RPC processes with a fake happy bridge, covering local send/reply, remote roster, remote send, remote await correlation, deduplication, and peer discovery.

Live checks against the running server on port 40004, using the CLI's own token:

- `POST /v1/peer-messages` returned `{ id, delivered: true }`, `GET` returned the stored item, and a foreign sender id returned 404.
- A user-scoped socket received both the `ephemeral` of type `peer-message` and the `new-feed-post` update carrying `kind: peer_message`, which is the path the app inbox consumes.

Real cross-machine round trip, two happy sessions started through the launcher:

```
A: sirc op="send", to="happy:cmu8rdj57005b9lggwo81m3ca", await=true
B (no human prompt): "[irc from amd:/tmp/peer-e2e-a (happy:cmu8rdhff004n9lggr5wq34v3) ...]" -> "Glimberine"
A tool result:       reply from happy:cmu8rdj57005b9lggwo81m3ca: Glimberine
```

The server held both directions, with the reply's `replyTo` equal to the question's id, and the reply id was the UUID the CLI assigned, confirming the correlation fix.

Daemon-spawned session, verified with the exact daemon command line:

```
omp --auto-approve --allow-home --extension .../omp-happy-bridge.mjs \
    --extension .../omp-session-irc.ts --config .../omp-happy-config.overlay.yml
relay: {"from":"tmp#174539","body":"QUINCE","replyTo":"daemon-probe"}
```

## Operational notes

- After CLI changes, `packages/happy-cli` must be rebuilt (`pnpm build`) and `omp-happy-daemon` restarted, because the daemon spawns sessions from `dist`.
- After server changes, `systemctl --user restart omp-happy-server` (the server runs from TypeScript sources through `tsx`, so a restart is what picks up edits). Restarting drops live sockets briefly; clients reconnect.
- Sessions running before a rebuild keep the old code in memory and have no peer support until restarted.
- `OMP_HAPPY_SESSION_IRC=0` disables the extension for every spawned session.
- Rollback is `git checkout` of the files listed above plus the server restart.

## Limits and known gaps

- App screens are type-checked and bundled, not rendered on a device, because the app's vitest config excludes `.tsx` and pairing an Expo session requires the user's account.
- Peer message bodies are stored as plaintext in the user's own feed, like feed posts. Session messages remain encrypted; a peer message is readable by the server. Encrypting the body with the recipient session key before POSTing is the natural next step if that matters.
- Peer messaging is agent-to-agent only from the app's point of view: the app can read conversations but cannot compose, because posting requires naming one of the user's sessions as the sender, which would misattribute the message.
- Delivery into an agent is live-only plus the bounded catch-up window. Messages sent while no CLI process runs for a session are visible in the inbox but never replayed into the agent.
- The reply relay sends the turn's final assistant text. If a turn ends without text, the peer receives an explicit "(this session finished the turn without a text answer)".
- Cross-user messaging does not exist. Both session ids must belong to the authenticated account.

## Artifacts left in place

Three test sessions created during verification and a few probe rows ("HTTP probe", "socket probe", plus the E2E exchange) remain visible in the app Inbox. They were left in place rather than deleted.

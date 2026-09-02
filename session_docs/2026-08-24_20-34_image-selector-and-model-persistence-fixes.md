# Image selector button layout and OMP model persistence fixes

## What was wrong

1. **Image Selector Button Missing / Inoperable in Companion App**:
   The image picker button (`image-outline`) stopped rendering or was unclickable on mobile screens. In recent builds, the newly added workspace file upload button (`onPickFiles`) and the Git status button were arranged inside the composer's action toolbar (`actionButtonsLeft`). `GitStatusButton` and its child `GitStatusBadge` had `flex: 1` and `overflow: 'hidden'`, which caused the Git status component to expand across the row and push the subsequent `ImagePicker` button off-screen, where it was clipped by the container's `overflow: 'hidden'`.

2. **False Error Alert on OMP Model Change ("Could not persist the selected OMP model")**:
   When switching models in an OMP session, the app showed a modal error dialog ("Could not persist the selected OMP model") even though the running OMP session switched models successfully.
   This was caused by two issues:
   - The CLI `set-model` RPC handler in `packages/happy-cli/src/omp/runOmp.ts` required `sent && persisted` to return success.
   - Background persistence in `packages/happy-cli/src/omp/ompModelConfig.ts` executes `omp config get modelRoles --json` through `execFileAsync`. The spawned non-login child process environment lacked `~/.bun/bin` in `PATH`, causing `/home/zarathustra/.local/bin/omp` to fail when locating `bun`. This caused `persistSelectedModel` to return `false`, which made the RPC return `{ success: false }` to the app even after the live session model was successfully updated via bridge.

---

## Debug process

1. **Investigating Recent Commits & Diffs**:
   - Reviewed recent commits: `8d460a0c` (wip: file upload, server attachment/storage changes, app tweaks), `d89170b9` (task model controls), `f21fcaff` (revert task controls), `d9f6d555` (RPC handler registration), and `6af8246c` (remove cross-process bridge).
   - Examined `packages/happy-app/sources/components/AgentInput.tsx`, `packages/happy-app/sources/components/GitStatusBadge.tsx`, and `packages/happy-app/sources/hooks/useImagePicker.ts`.
   - Identified that `GitStatusButton` contained `flex: 1` and `overflow: 'hidden'`, expanding inside the flex row and pushing subsequent buttons out of the viewport.

2. **Investigating Model Persistence RPC Failure**:
   - Traced `sessionSetModel` from `packages/happy-app/sources/-session/SessionView.tsx` through `packages/happy-app/sources/sync/ops.ts` to `packages/happy-app/sources/sync/apiSocket.ts` and the CLI handler in `packages/happy-cli/src/omp/runOmp.ts`.
   - Tested `omp config get modelRoles --json` directly in shell. The command failed with `/home/zarathustra/.local/bin/omp: 45: exec: bun: not found` unless `PATH` included `~/.bun/bin`.
   - Confirmed that `persistOmpDefaultModel` was throwing this error, resulting in `persisted = false` and causing `set-model` to report failure despite `sent = true`.

---

## Final fixes

### 1. Happy App Layout Fixes (`AgentInput.tsx`, `GitStatusBadge.tsx`)
- Removed `flex: 1` and `overflow: 'hidden'` from `GitStatusButton` (`packages/happy-app/sources/components/AgentInput.tsx`).
- Removed `flex: 1` and `overflow: 'hidden'` from `GitStatusBadge` (`packages/happy-app/sources/components/GitStatusBadge.tsx`).
- Added `alignItems: 'center'` to `actionButtonsLeft` in `AgentInput.tsx` to align toolbar action icons cleanly across the bar.
- Moved the Image Picker button (`props.onPickImages`) to the right action cluster immediately adjacent to the Send/Voice button for quick thumb access.

### 2. Happy CLI Model Configuration & RPC Fixes (`ompModelConfig.ts`, `runOmp.ts`)
- Updated `createOmpConfigCommandRunner` in `packages/happy-cli/src/omp/ompModelConfig.ts` to construct an augmented `PATH` containing `~/.bun/bin` and `~/.local/bin`, ensuring `omp` can execute `bun` in non-login environments.
- Updated `set-model` RPC handler in `packages/happy-cli/src/omp/runOmp.ts` to return `sent || persisted`, so live model switches report success immediately when sent to the running session bridge.
- Rebuilt and relinked the global Happy CLI via `pnpm cli:install` and restarted the background daemon.

---

## Verification & Deployment

1. **Test Suites**:
   - `pnpm --filter happy-app typecheck` (`tsc --noEmit`) passed with 0 errors.
   - `pnpm --filter happy-app test run` passed (66 test files, 786 tests).
   - `pnpm --filter happy exec vitest run src/omp/` passed (33 tests).
2. **Android Release Build & Deployment**:
   - Assembled release APK with `./gradlew assembleRelease` in `packages/happy-app/android`.
   - Installed the release APK (`gg.omp.companion.dev`) onto the connected Pixel 9 Pro via `adb install -r`.
   - Restored phone rotation lock with `accelerometer_rotation 0` and `user_rotation 0`.
   - Confirmed live on the device:
     - The image selector button (`image-outline`) is rendered on the right side immediately adjacent to the Send/Voice button.
     - Left-side actions (Settings, Git status badge, workspace file upload) remain aligned without clipping.
     - Switching models in active OMP sessions succeeds without RPC alerts.

---

## Key findings

- **Action toolbar flex constraints**: Child components in a horizontal button bar (`actionButtonsLeft`) must not use `flex: 1` unless intended as an expanding spacer. Adding expanding flex to intermediate items pushed right-side action buttons out of the viewport.
- **Child process PATH propagation**: Helper utilities invoking CLI binaries via `execFile` or `execFileAsync` must provide a `PATH` that includes user binary paths (`~/.bun/bin`, `~/.local/bin`) because non-login subprocesses in Node do not inherit interactive shell profile additions.
- **RPC success decoupled from background persistence**: When an RPC controls a live session state (e.g. switching the current model), success must reflect the primary live operation rather than blocking on or failing due to secondary background persistence operations.

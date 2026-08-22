# Native task model selection and multi-machine deployment

## What was wrong

Happy exposed separate Chat and Tasks model choices, but the Chat RPC changed OMP's default model globally. That also changed the model used for delegated tasks while the Tasks picker could continue displaying its previous local selection. The UI could therefore display a task model that no longer matched the model OMP would use.

The first attempted solution added a separate Happy extension tool named `model_task`. That tool could select a model, but it launched a separate subprocess and did not preserve the native `task` tool's complete behavior. It lacked the existing Agent Hub lifecycle, asynchronous jobs, batching, isolation, steering, nested spawning, structured outputs, progress, retry handling, and other native task features. That implementation was rejected and fully reverted.

## Investigation and decisions

The OMP task path was traced through:

- `packages/coding-agent/src/task/types.ts`
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/config/model-resolver.ts`
- `packages/coding-agent/src/prompts/tools/task.md`

OMP already had the required internal mechanism. `StructuredSubagentRequest` accepted `model?: string | string[]`, and `resolveAgentModelSelection` already treated a request model as higher priority than `task.agentModelOverrides` and the selected agent definition. The missing part was only the public native `task` schema and the forwarding from task arguments into that existing request field.

The final design therefore adds one optional `model` field to the existing native `task` tool. It does not add or replace a subagent implementation.

The per-call selector:

- Overrides `task.agentModelOverrides` and agent frontmatter for that invocation.
- Accepts normal OMP selectors, role aliases, and thinking suffixes such as `:high`.
- Does not change the parent chat model.
- Does not persist a role or default-model setting.
- Preserves the native agent type, tool restrictions, Agent Hub registration, asynchronous execution, batching, isolation, output schemas, effort selection, steering, retry behavior, history, and usage tracking.

## Rollback of the incorrect Happy implementation

The incorrect Happy extension and UI implementation was reverted with:

- Happy repository rollback commit: `f21fcaff`
- Branch: `feat/omp-happy-extension-bridge`
- Remote: `github.com:inspector123/omp-happy.git`

That rollback removes the separate `model_task` subprocess implementation. The final model-selection behavior lives in OMP core instead.

The rollback was then built and installed from commit `f21fcaff`. The local and `Z.local` Happy daemons report version `1.1.10`. The Mac CLI also reports `1.1.10`; its daemon is intentionally not running. The `jobapp` checkout and CLI link were updated, but that account has no Happy credentials, so its daemon correctly stops at the authentication flow instead of starting.

## OMP implementation

The OMP core change was committed as:

- Commit: `b1dc110f37ba9941c0785780e1852795766a741f`
- Short commit: `b1dc110f3`
- Repository: `https://github.com/inspector123/oh-my-pi`
- Branch: `main`
- Commit URL: `https://github.com/inspector123/oh-my-pi/commit/b1dc110f3`

A follow-up at `531faedf85` made the native task guidance explicit: model-specific delegation must use `task.model` and must never launch another OMP process. Its regression test verifies that both requirements remain in the generated tool description.

Direct push access to `can1357/oh-my-pi` was denied for the `inspector123` GitHub account. A writable `inspector123/oh-my-pi` fork was created and the change was rebased onto that fork's current `main` before being pushed.

### Source changes

`packages/coding-agent/src/task/types.ts` now exposes `model?: string` in:

- `TaskItem`
- `TaskParams`
- Flat task schemas
- Batch item schemas
- Isolation-enabled and isolation-disabled schemas
- Dynamically generated task schemas

`packages/coding-agent/src/task/index.ts` now carries the model through every native stage:

1. Flat task arguments are normalized into a task item.
2. Per-item arguments are copied into spawn parameters.
3. Atomic preflight policy resolution receives the model.
4. Final `runStructuredSubagent` execution receives the same model.

The task prompt, task-agent discovery documentation, and coding-agent changelog were updated. Regression coverage was added for:

- Flat schema retention of `model`.
- Flat execution precedence over configured agent overrides.
- Batch schema placement inside each `tasks[]` item.
- Independent model selectors for different items in one batch.

### Usage

Flat form:

```json
{
  "agent": "reviewer",
  "model": "openai/gpt-5.6-sol:high",
  "task": "Review the authentication changes."
}
```

Batch form:

```json
{
  "context": "Shared repository context.",
  "tasks": [
    {
      "agent": "scout",
      "model": "anthropic/claude-haiku-4-5:low",
      "task": "Map the relevant code."
    },
    {
      "agent": "reviewer",
      "model": "openai/gpt-5.6-sol:high",
      "task": "Review the implementation."
    }
  ]
}
```

## Local verification

Verification was rerun after rebasing onto the fork's current `main`:

- Focused native task tests: 34 passed, 0 failed.
- Coding-agent TypeScript check: `tsgo -p tsconfig.json --noEmit` passed.
- Biome check on the changed TypeScript and test files passed.
- Runtime schema smoke check retained the requested model exactly:

```json
{"agent":"task","task":"smoke","model":"openai/gpt-5.6-sol:high"}
```

The local checkout initially lacked Bun, workspace dependencies, and a built native addon. Bun was available at `~/.bun/bin/bun`; workspace dependencies and generated tool views were installed. The installed OMP native addon was used for focused tests after a local Cargo build could not run because Cargo was unavailable.

An end-to-end JSON event-stream smoke test then ran the real native lifecycle from a `gpt-5.6-sol` parent. The parent invoked `task` with `model: "openai-codex/gpt-5.5"` and waited through `hub`. Runtime progress reported `resolvedModel: "openai-codex/gpt-5.5:low"`, the native job moved from pending to running to completed, and the result was `NATIVE_JSON_OK`. No subprocess extension or second OMP command was involved.

## Deployment strategy

For this unreleased change, source-linked checkouts are preferable to copying standalone binaries. Each machine now pulls from the fork and runs OMP directly from that checkout. Ordinary TypeScript updates take effect after `git pull` without rebuilding or relinking.

All three SSH targets accepted passwordless authentication. No password was requested or used.

Bun 1.4.0 was installed in each account. Each checkout ran its configured coding-agent typecheck before it was linked. Platform-native addons were installed from the published OMP 17.4.0 platform packages because the unreleased source version is 17.4.3 and matching 17.4.3 native leaf packages are not published yet.

This native combination is deliberate for a workspace checkout. OMP's native loader explicitly skips release-sentinel validation for workspace loads so a source checkout remains usable after pulling a version bump while a native rebuild is pending. A source diff from `v17.4.0` to the deployed commit showed that the native API was unchanged; only the version sentinel and licensing metadata changed.

Each account has these links:

1. `~/.bun/bin/omp` points to `packages/coding-agent/scripts/omp` in its checkout.
2. `~/.local/bin/omp` points to `~/.bun/bin/omp` so existing PATHs and Happy can continue resolving the same command location.
3. `~/.local/bin/bun` points to `~/.bun/bin/bun` so the source launcher works from non-interactive and service environments whose PATH already contains `~/.local/bin`.

Happy's OMP launcher prefers `~/.bun/bin/omp` when it exists, so new Happy-managed OMP sessions resolve the source-linked version.

## Machine results

### `Z.local`

- Account: `zarathustra`
- Checkout: `/home/zarathustra/projects/oh-my-pi`
- Commit: `531faedf85`
- Reported version: `omp/17.4.3`
- Deployment log: `/home/zarathustra/omp-task-model-install.log`
- Previous binary backup: `/home/zarathustra/.local/bin/omp.pre-native-task-model-17.3.1`
- Runtime task schema smoke check: passed.

### `vance@mac.lan`

- Platform: macOS arm64
- Checkout: `/Users/vance/projects/oh-my-pi`
- Commit: `531faedf85`
- Reported version: `omp/17.4.3`
- Deployment log: `/Users/vance/omp-task-model-install.log`
- Previous binary backup: `/Users/vance/.local/bin/omp.pre-native-task-model-17.4.1`
- Runtime task schema smoke check: passed.

### `jobapp@z.local`

- Checkout: `/home/jobapp/projects/oh-my-pi`
- The previous upstream remote was retained as `upstream`.
- The writable fork is now `origin`, and local `main` tracks `origin/main`.
- Commit: `531faedf85`
- Reported version: `omp/17.4.3`
- Deployment log: `/home/jobapp/omp-task-model-install.log`
- Previous binary backup: `/home/jobapp/.local/bin/omp.pre-native-task-model-17.3.4`
- Runtime task schema smoke check: passed.

## Future updates

For ordinary OMP TypeScript changes pushed to `inspector123/oh-my-pi:main`, update all three machines with:

```bash
ssh Z.local 'git -C ~/projects/oh-my-pi pull --ff-only'

ssh vance@mac.lan \
  'git -C ~/projects/oh-my-pi pull --ff-only'

ssh jobapp@z.local \
  'git -C ~/projects/oh-my-pi pull --ff-only'
```

The source links remain valid after the pull. If a future change modifies dependencies, generated assets, package versions, or native Rust code, rerun the relevant install, generation, typecheck, and native-addon steps instead of relying on pull alone.

## Key findings

- The complete native subagent behavior did not need to be recreated in an extension.
- OMP already supported request-scoped model selection internally; the native task tool omitted the public argument and forwarding.
- A per-item field supports both single and batched tasks without touching the parent model or persistent settings.
- Explicit task guidance prevents a model from mistaking per-call selection for permission to launch a separate OMP subprocess.
- Source-linked installations are the simplest way to distribute an unreleased OMP core change across these machines.
- Existing standalone binaries were preserved as rollback copies on every target.

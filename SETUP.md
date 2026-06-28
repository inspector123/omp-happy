# omp-happy — setup on a new box

Get the omp-happy CLI + daemon running on a fresh machine so you can drive
**omp** from your phone (and locally). The phone app is the same; this box just
needs the forked CLI + daemon + omp itself.

> Isolation: everything here uses `HAPPY_HOME_DIR=~/.omp-happy`, a separate
> account dir, so it never touches a real Happy install (`~/.happy`).

---

## 0. Prerequisites

- **omp (oh-my-pi)** installed and authed with your providers. Configure these
  with regular omp — keys live under `~/.omp`. Verify: `omp acp --help` works.
  Make sure the binary is on PATH (it's usually `~/.local/bin/omp`).
- **Node ≥ 20.19** (22 is fine). **pnpm**.
- **git**, and `gh` if you want to clone the private repo via CLI.
- A reachable **Happy server** (you self-host one — e.g. `http://<host>:30003`).
  The relay is agent-blind; both CLI and app just need to point at the same one.
- **Only if you'll (re)build the Android app on this box:** Android SDK
  (`~/Android/Sdk` with NDK + build-tools), Java 17/21, `adb`. Usually you don't
  — the APK already lives on your phone.

## 1. Clone + install

```bash
git clone git@github.com:inspector123/omp-happy.git ~/projects/omp-happy
cd ~/projects/omp-happy
git checkout omp-backend          # the fork branch (default)
pnpm install
pnpm -C packages/happy-cli build  # → packages/happy-cli/dist
```

## 2. Account: reuse vs fresh

**Reuse (recommended — phone already paired):** copy your account dir from the
old box so this machine joins the *same* omp-happy account; your phone then sees
it as a new machine, no re-pairing.

```bash
# from the old box (or a backup):
rsync -a ~/.omp-happy/access.key ~/.omp-happy/settings.json  newbox:~/.omp-happy/
```

**Fresh:** skip the copy. First run (step 4) prints a QR — scan it with the OMP
app to pair this box as a new account.

## 3. Point at your server

The CLI/daemon read `HAPPY_SERVER_URL`. Easiest: export it in your shell rc.

```bash
export HAPPY_SERVER_URL=http://<your-happy-server>:30003   # e.g. LAN 192.168.0.252:30003
```

The repo helper scripts also default it (edit `scripts/omp-run.sh` /
`scripts/omp-daemon.sh` if your address differs), and you can override per-run
with `HAPPY_SERVER_URL=… scripts/omp-run.sh`.

## 4. Run it

```bash
# Prepare for remote spawn (registers this machine so the phone can launch omp):
scripts/omp-daemon.sh start          # status | stop | restart (restart after rebuilding CLI)

# Interactive local session, mirrored to the phone (first run pairs if fresh):
scripts/omp-run.sh
```

Then drive omp from the phone (**＋ New session → omp**, picking this machine) or
type locally in the `omp›` prompt. Both flows default to `--yolo` (allow-all
tool permissions) and `--local`.

Manual equivalent (no scripts):
```bash
HAPPY_HOME_DIR=~/.omp-happy PATH=$PATH:~/.local/bin \
  node packages/happy-cli/bin/happy.mjs acp omp --local --yolo
```

## 5. (Optional) build the Android app on this box

Only if you need a fresh APK (new bundle, different server, etc.). It already
runs on your phone otherwise.

```bash
cd packages/happy-app
ANDROID_HOME=$HOME/Android/Sdk npx expo prebuild --platform android --no-install

# After prebuild, re-apply two things the generated android/ dir doesn't keep:
#  - android/gradle.properties: org.gradle.jvmargs=-Xmx8192m -XX:MaxMetaspaceSize=2048m
#  - android/app/build.gradle  android {}: lint { checkReleaseBuilds false }
#  - android/app/src/main/AndroidManifest.xml <application>: android:usesCleartextTraffic="true"
#    (only needed for a plain-HTTP / LAN server)

cd android
EXPO_PUBLIC_HAPPY_SERVER_URL=http://<your-EXTERNAL-server>:30003 \
  ANDROID_HOME=$HOME/Android/Sdk ./gradlew assembleRelease --no-daemon
adb install -r app/build/outputs/apk/release/app-release.apk
```

Notes: release uses the debug keystore → standalone signed APK, no custom
keystore. The app reads **`EXPO_PUBLIC_HAPPY_SERVER_URL`** at build time only
(it ignores `HAPPY_SERVER_URL`). Phone is often off-LAN, so point the app at an
**externally reachable** address while the CLI uses the LAN one — same physical
server; pairing works because the QR carries only the keypair.

## 6. In-app settings worth flipping

- **Settings → Features → "Resume sessions" (experimental)** — reveals the
  Resume action so you can continue a prior/dead omp session (ACP session/load).
- **Settings → Appearance → "Show reasoning"** — on by default; omp's reasoning
  blocks.
- **Settings → Features → Manage Models** (or the composer gear) — curate omp's
  long model list down to the few you use.

## 7. Verify

```bash
scripts/omp-daemon.sh status                 # daemon up, has pid/httpPort
omp acp --help                               # omp reachable on PATH
HAPPY_HOME_DIR=~/.omp-happy ls ~/.omp-happy   # access.key present = paired
```
Send a prompt from the phone → it should respond with no permission prompts.

---

## Gotchas (learned the hard way)

- **omp must be on PATH** for the daemon, or `omp acp` is ENOENT. The scripts add
  `~/.local/bin`.
- **`--allow-home`** is baked into the omp launch (acpAgentConfig) so omp doesn't
  auto-switch out of `~` to a temp dir — required for sessions/resume to stay in
  one project.
- **Daemon won't reload new CLI code on a same-version restart** — use
  `scripts/omp-daemon.sh restart` (stop+start) after `pnpm -C packages/happy-cli build`.
- **CLI-only changes need no APK** — rebuild CLI + restart daemon + start a fresh
  session. Only app/UI changes need a new APK.
- **Never run the forked `bin/happy.mjs` bare** (without `HAPPY_HOME_DIR`) — it
  would use your real `~/.happy`. Always go through the scripts / set the env.
- **Gradle Metaspace OOM** on the app build → the jvmargs bump above. Skip
  release lint (`checkReleaseBuilds false`).

See `README.omp.md` for what the fork changes, and `~/session_docs/2026-06-2*-omp-happy*.md`
for the full build/diagnostic history.

> **This is [omp-happy](README.omp.md)** — a fork of Happy that drives **omp (oh-my-pi)** as a first-class agent. See **[README.omp.md](README.omp.md)** for what's different and how to run it. The original Happy README follows.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="400" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Mobile and Web Client for Claude Code & Codex
</h1>

<h4 align="center">
Use Claude Code or Codex from anywhere with end-to-end encryption.
</h4>

<div align="center">
  
[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

> **Hosted-service quickstart:** the download/install quickstart on this page
> intentionally uses Happy's upstream hosted service. To run this fork against
> your own server, follow the self-hosted path below and set every client URL
> explicitly.

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

<h3 align="center">
Step 3: Start using `happy` instead of `claude` or `codex`
</h3>

```bash
# Instead of claude, use:
happy claude
# or
happy codex
```

## Self-hosting this fork

Happy has three trust boundaries: the **server** stores accounts and encrypted
sync records; the **CLI/daemon** runs agents on a computer; and the
**mobile/web/Electron clients** display and control those sessions. The clients
must all use the same server origin. Accounts, bearer tokens, and encrypted
records are server-specific; pointing one device at another server does not
migrate them.

The upstream CLI and mobile app retain their official hosted defaults for
existing hosted users. A self-hosted setup must not rely on those fallbacks.
Use an isolated home and an explicit private URL:

```bash
git clone <your-fork-url> omp-happy
cd omp-happy
pnpm install

export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev
```

`self-host:dev` builds the local CLI and runs `happy server`. It binds to
`127.0.0.1:3005`, creates isolated PGlite/file state under
`$HAPPY_HOME_DIR/server-data`, generates a 32-byte master secret on first run,
and asks before persisting the local API/web URL. In another terminal:

```bash
curl --fail http://127.0.0.1:3005/health
# {"status":"ok",...,"service":"happy-server"}
```

A phone cannot reach a computer's `127.0.0.1`. For a trusted LAN, bind on all
interfaces but advertise the computer's reachable address:

```bash
pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url http://192.168.1.20:3005
```

For Internet access, put the server behind a reverse proxy and advertise an
origin such as `https://happy.example`. Production must use trusted HTTPS; the
proxy must pass Socket.IO WebSocket upgrades so HTTPS clients connect over WSS.
Do not expose account traffic over public HTTP.

### Link the app, CLI, daemon, and Electron

1. **Configure the app before login.** Use the pre-login custom-server selector,
   or build mobile with the source-backed variable
   `EXPO_PUBLIC_HAPPY_SERVER_URL=https://happy.example`. The similarly named
   `EXPO_PUBLIC_SERVER_URL` is not used for sync. For a local Android release:

   ```bash
   cd packages/happy-app/android
   EXPO_PUBLIC_HAPPY_SERVER_URL=http://192.168.1.20:3005 \
     ./gradlew assembleRelease
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

   Local/LAN HTTP is for trusted development networks only. Use HTTPS for a
   public build.

2. **Establish the app account, then link the CLI.** Happy login is key-based;
   there is no Happy email/password. Open the configured app (or configured
   self-hosted web app), then run:

   ```bash
   cd /path/to/omp-happy
   export HAPPY_HOME_DIR="$HOME/.happy-self-host"
   export HAPPY_SERVER_URL=http://192.168.1.20:3005
   export HAPPY_WEBAPP_URL="$HAPPY_SERVER_URL"

   pnpm cli auth login
   # Choose Mobile Authentication and approve the displayed QR in the app.
   pnpm cli auth status
   pnpm cli daemon start
   pnpm cli acp omp --local
   ```

   The QR contains an ephemeral public key. The app encrypts the CLI credential
   response to that key; the CLI decrypts it locally and stores its bearer token
   and client key material in `$HAPPY_HOME_DIR/access.key`. The server receives
   public-key proofs, bearer identity, and ciphertext—not the app's private
   account key or plaintext session keys.

3. **Start Electron with the same CLI home and server.** Electron deliberately
   has no endpoint fallback and no separate login; it reads the local CLI
   credentials and keys:

   ```bash
   HAPPY_HOME_DIR="$HOME/.happy-self-host" \
   HAPPY_SERVER_URL=http://192.168.1.20:3005 \
     pnpm --filter happy-desktop dev
   ```

For friends, share only the HTTPS server URL. Each person configures that URL
before app login, establishes their own key-based account, and approves their
own CLI QR from their own app. Never share `HANDY_MASTER_SECRET`, `access.key`,
`agent.key`, or another person's `$HAPPY_HOME_DIR`.

See **[SETUP.md](SETUP.md)** for the complete clean-clone and friend-onboarding
flow, **[docs/deployment.md](docs/deployment.md)** for production dependencies,
TLS, secrets, backups, and Docker, and
**[packages/happy-server/README.md](packages/happy-server/README.md)** for the
standalone server.

## How does it work?

On your computer, run `happy` instead of `claude` or `happy codex` instead of `codex` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code and Codex** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude Code and Codex needs permission or encounters errors  
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Command-line interface for Claude Code and Codex
- **[Happy Agent](https://github.com/slopus/happy/tree/main/packages/happy-agent)** - Remote agent control CLI (create, send, monitor sessions)
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - Backend server for encrypted sync

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation Website](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[Contributing Guide](docs/CONTRIBUTING.md)** - How to contribute, PR guidelines, and development setup
- **[Edit docs at github.com/slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)** - Help improve our documentation and guides

## License

MIT License - see [LICENSE](LICENSE) for details.

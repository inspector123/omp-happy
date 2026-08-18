# Happy Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Hosting choices

Upstream Happy clients can use the official hosted service, but self-hosted
clients must explicitly select the operator's own origin. The app, CLI/daemon,
and Electron client must all use that same server; accounts and credentials are
server-specific.

### Local server from this repository

From the monorepo root:

```bash
pnpm install
export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev
curl --fail http://YOUR-LAN-IP:3005/health
```

The root script builds the local CLI and invokes `happy server`, which generates
a persistent 32-byte master secret, migrates embedded PGlite, uses local file
storage, and keeps all server data under
`$HAPPY_HOME_DIR/server-data`. It binds to the LAN by default and detects a
private IPv4 address for the phone-reachable URL. No external services are
required.

If automatic address detection picks the wrong interface, set the URL explicitly:

```bash
pnpm run self-host:dev -- \
  --public-url http://192.168.1.20:3005
```

Use [`../../SETUP.md`](../../SETUP.md) to link clients and
[`../../docs/deployment.md`](../../docs/deployment.md) for TLS, production
secrets, backups, S3, PostgreSQL, and Redis.

### Standalone Docker image

The root `Dockerfile` runs PGlite, local files, and an in-process event bus in
one container:

```bash
docker build -t happy-server -f Dockerfile .
docker run --name happy-server \
  -p 127.0.0.1:3005:3005 \
  -e HOST=0.0.0.0 \
  -e PUBLIC_URL=https://happy.example \
  -e HANDY_MASTER_SECRET="$(openssl rand -hex 32)" \
  -v happy-data:/data \
  happy-server
```

For a durable deployment, persist the generated secret outside shell history
and back it up with the `happy-data` volume; the complete production command is
in the deployment guide. Put the container behind HTTPS/WSS before exposing it
publicly.

### Standalone environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Persistent high-entropy server secret |
| `HOST` | No | `0.0.0.0` | Listen address |
| `PORT` | No | `3005` | HTTP and Socket.IO port |
| `PUBLIC_URL` | Recommended | `http://localhost:3005` | Client-reachable origin used for local file URLs |
| `DATA_DIR` | No | `./data` (`/data` in Docker) | PGlite and local-file base directory |
| `PGLITE_DIR` | No | `$DATA_DIR/pglite` | PGlite database directory |

The standalone runtime does not require `DATABASE_URL`, `REDIS_URL`, or S3.
External PostgreSQL and multi-replica deployments use `Dockerfile.server` or
the Kubernetes manifests and the conditional variables documented in
`docs/deployment.md`.

### S3 bucket configuration (when self-hosting with S3)

When `S3_HOST` is set, image attachments and other blobs land in S3 under
`sessions/<sessionId>/attachments/<id>.enc`. Two bucket-level settings are
not configured by the server itself and must be applied once at deploy
time:

**1. Lifecycle rule for attachment TTL.** Encrypted blobs are deleted when
their session is deleted, but a long-lived session would otherwise keep
its blobs forever. Add a lifecycle rule on the attachments prefix so
objects age out automatically. Pick a TTL that matches your retention
policy (30 days is a reasonable default).

```bash
# AWS CLI
aws s3api put-bucket-lifecycle-configuration --bucket happy-blobs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "session-attachments-ttl",
      "Status": "Enabled",
      "Filter": { "Prefix": "sessions/" },
      "Expiration": { "Days": 30 }
    }]
  }'

# MinIO
mc ilm rule add myminio/happy-blobs \
  --expire-days 30 \
  --prefix "sessions/"
```

**2. Server-side encryption (defense-in-depth).** Blobs are already
end-to-end encrypted by the client, but enabling AES-256 SSE on the
bucket protects against an attacker who somehow obtains raw object
storage access without the keys.

```bash
# AWS CLI
aws s3api put-bucket-encryption --bucket happy-blobs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# MinIO
mc encrypt set sse-s3 myminio/happy-blobs
```

Local-storage mode (no `S3_HOST`) writes blobs under
`<DATA_DIR>/files/sessions/<sessionId>/attachments/`. There is no
lifecycle equivalent — clean up old session directories on a cron if
you want a TTL story.

## License

MIT - Use it, modify it, deploy it anywhere.
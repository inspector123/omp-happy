# Happy server deployment

This document describes the backend in `packages/happy-server`. Client linking
and friend onboarding are covered in [`../SETUP.md`](../SETUP.md).

## Choose a runtime mode

| Mode | State and dependencies | Intended use |
|------|------------------------|--------------|
| `happy server` / `pnpm self-host:dev` | Embedded PGlite, local files, one Node process | Recommended local bootstrap and small private installations |
| Root `Dockerfile` | The same standalone PGlite/local-file runtime in one container | Single-node production behind a reverse proxy |
| `Dockerfile.server` / Kubernetes manifests | External PostgreSQL; optional Redis and S3 | Operators who need managed storage or multiple replicas |

No Docker Compose stack is needed for standalone mode. It has no required
Postgres, Redis, or S3 dependency.

## Reproducible local bootstrap

From the repository root:

```bash
pnpm install
export HAPPY_HOME_DIR="$HOME/.happy-self-host"
pnpm run self-host:dev
```

The CLI command generates and persists a random master secret, runs PGlite
migrations, starts on `127.0.0.1:3005`, and asks before writing the server/web
URL into the isolated settings file.

Verify the database-backed health route:

```bash
curl --fail http://127.0.0.1:3005/health
```

For LAN or reverse-proxy use, separate the bind address from the URL clients
receive:

```bash
# Trusted LAN only
pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url http://192.168.1.20:3005

# Public HTTPS reverse proxy
pnpm run self-host:dev -- \
  --host 0.0.0.0 \
  --public-url https://happy.example
```

`--public-url` accepts an HTTP(S) origin only. It is required with wildcard
binds.

The direct source script remains available for server-only development:

```bash
pnpm --dir packages/happy-server standalone:dev
```

It loads the sanitized development-only values in
`packages/happy-server/.env.dev`. Do not use that file's local master secret in
production.

## Single-container deployment

The root `Dockerfile` builds the standalone runtime. Generate the persistent
secret outside the repository:

```bash
install -d -m 700 "$HOME/.config/happy-server"
openssl rand -hex 32 > "$HOME/.config/happy-server/master-secret"
chmod 600 "$HOME/.config/happy-server/master-secret"

docker build -t happy-server -f Dockerfile .
docker run --name happy-server \
  --restart unless-stopped \
  -p 127.0.0.1:3005:3005 \
  -e HOST=0.0.0.0 \
  -e PORT=3005 \
  -e PUBLIC_URL=https://happy.example \
  -e HANDY_MASTER_SECRET="$(cat "$HOME/.config/happy-server/master-secret")" \
  -v happy-data:/data \
  happy-server
```

Keep the container port on loopback and publish it through a TLS reverse proxy.
Back up both the `happy-data` volume and the master-secret file. Restoring only
one is not a complete server restore.

## Environment variables

### Standalone mode

| Variable | Requirement | Meaning |
|----------|-------------|---------|
| `HANDY_MASTER_SECRET` | **Required** | Persistent high-entropy server secret. `happy server` generates it; other launch methods should use at least `openssl rand -hex 32`. |
| `HOST` | Optional, default `0.0.0.0` | Listen address. The interactive `happy server` wrapper also defaults to LAN access so mobile clients can connect. |
| `PORT` | Optional, default `3005` | HTTP and Socket.IO port. |
| `PUBLIC_URL` | Recommended outside loopback | Canonical client-reachable HTTP(S) origin used for local attachment URLs. `happy server` detects a private LAN address when omitted. |
| `DATA_DIR` | Optional, default `./data` (`/data` in Docker) | Base directory for PGlite and local attachments. |
| `PGLITE_DIR` | Optional, default `$DATA_DIR/pglite` | Embedded database directory. |
| `DB_PROVIDER` | Optional, default `pglite` in standalone | Database adapter selection. |
| `HAPPY_STATIC_DIR` | Optional | Directory containing a bundled web app. |
| `HAPPY_INJECT_HTML_CONFIG` | Internal/optional | JSON injected by `happy server` into a bundled self-hosted web app. |

### External-service mode

Set these when running `sources/main.ts`, `Dockerfile.server`, or the Kubernetes
deployment:

| Variable | Requirement | Meaning |
|----------|-------------|---------|
| `HANDY_MASTER_SECRET` | **Required** | Same persistent server secret described above. |
| `DB_PROVIDER=postgres` | **Required explicitly** | Select the normal Prisma PostgreSQL client. |
| `DATABASE_URL` | **Required with PostgreSQL** | PostgreSQL connection string. Apply the checked-in Prisma migrations before serving traffic. |
| `REDIS_URL` | Optional for one process; required for multiple replicas | Enables Redis connectivity and the Socket.IO Redis Streams adapter. |
| `S3_HOST` | Optional | Enables S3-compatible storage instead of local files. If set, the complete S3 group below is required. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` | **Required when `S3_HOST` is set** | S3 credentials, bucket, and client-reachable object origin. |
| `S3_PORT` | Optional | S3 service port. |
| `S3_USE_SSL` | Optional, default `true` | Whether the server-to-S3 connection uses TLS. |
| `S3_REGION` | Optional, default `us-east-1` | S3 region. |

Local filesystem storage writes to `$DATA_DIR/files`. S3 is not required unless
`S3_HOST` is set.

### Metrics and optional integrations

| Variable(s) | Meaning |
|-------------|---------|
| `METRICS_ENABLED`, `METRICS_PORT`, `METRICS_HOST` | Metrics are disabled by default. Set `METRICS_ENABLED=true` to enable the separate Prometheus server; it binds to `127.0.0.1:9090` unless explicitly changed. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URL` | Optional GitHub OAuth. |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_REDIRECT_URI`, `GITHUB_WEBHOOK_SECRET` | Additional values required for GitHub App/webhook support. |
| `ELEVENLABS_API_KEY`, `REVENUECAT_API_KEY` | Optional voice and subscription integration. Voice routes report configuration errors when required keys are absent. |
| `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` | Enables bounded client debug-log ingestion only when exactly `true` in a non-production process. Leave it unset normally. |

Secrets must come from a secret manager or a root-readable file outside the
repository. Never commit generated secrets, `.env`, access tokens, or client
credential files.

## TLS, WSS, and proxy requirements

Localhost and a trusted LAN may use HTTP while testing. Any origin reachable
from the public Internet must use a publicly trusted HTTPS certificate.
Socket.IO uses the `/v1/updates` path; forward its HTTP requests and WebSocket
upgrade headers. Preserve `Host` and `X-Forwarded-Proto` so attachment URLs use
the public HTTPS origin. HTTPS automatically results in WSS for clients.

After configuring the proxy, verify the public path rather than only the
container:

```bash
curl --fail https://happy.example/health
```

## Data and backup boundary

For standalone deployments, back up:

- `DATA_DIR` (PGlite under `PGLITE_DIR` and attachments under `files/`); and
- the exact `HANDY_MASTER_SECRET` used with that data.

For external deployments, back up PostgreSQL and the S3 bucket according to
their native procedures, plus the server secret. Redis is transport/cache state,
not the primary database.

## Kubernetes and scale-out references

Example manifests live in `packages/happy-server/deploy`:

- `handy.yaml`: server Deployment, Service, and ExternalSecret references.
- `happy-redis.yaml`: Redis StatefulSet, Service, and exporter.
- `overlays/local/minio.yaml`: local-development MinIO.

The manifests expect a `handy-secrets` secret populated by the operator's
ExternalSecret provider. The Service maps port `3000` to container port `3005`;
the application should still receive `PORT=3005`. S3 production infrastructure
is external to these manifests.

The root `Dockerfile.server` is the external-service image. Unlike the standalone
root `Dockerfile`, it does not bundle PGlite startup/migration orchestration.

## Source references

- Standalone CLI wrapper: `packages/happy-cli/src/commands/server.ts`
- Standalone runtime: `packages/happy-server/sources/standalone.ts`
- Health route: `packages/happy-server/sources/app/api/utils/enableMonitoring.ts`
- Environment use: `packages/happy-server/sources`
- Standalone image: `Dockerfile`
- External-service image: `Dockerfile.server`

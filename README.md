# Linguist

Programmable script-routed `OpenAI` Chat API gateway and read-only token telemetry dashboard built with Rust, PostgreSQL, and React.

## Quick Commands

```powershell
# Check config and pre-compile all 5-stage TS/JS scripts
cargo run -- check-config

# Seed 180 days of demo telemetry into PostgreSQL
cargo run -- seed-demo --days 180

# Start gateway & embedded telemetry dashboard on http://127.0.0.1:9527
cargo run -- serve
```

Built-in SVG icons for major providers/models are served read-only from memory (`/icons/{slug}.svg`), with automatic monogram fallback in the web dashboard; no local icon directory or sync step is needed.

## Docker Deployment (External PostgreSQL)

Linguist provides a pure-binary `scratch` multi-arch container image (`linux/amd64` and `linux/arm64`) published to:

```text
ghcr.io/preca-hoshino/linguist
```

- The container image contains only `/linguist` and the empty `/config` mount point (`WORKDIR /config`, running as non-root `65532:65532`).
- [compose.yaml](compose.yaml) runs only the `linguist` service and does **not** create a PostgreSQL container or data volumes. You must provide an external PostgreSQL instance.
- Production deployments should pin an explicit version tag (matching the GitHub Release, e.g. `v0.1.0-b12-abcdef`) or `@sha256:...` digest instead of `:latest`.

### 1. Prepare Host Config Directory

```bash
mkdir -p docker/config/scripts
cp config.docker.example.toml docker/config/config.toml
cp chatLanguageModels.example.json docker/config/chatLanguageModels.json
cp projects.json docker/config/projects.json
cp routes.json docker/config/routes.json
chmod 755 docker/config docker/config/scripts
chmod 644 docker/config/config.toml docker/config/*.json
```

> **Note:** Mount the entire config **directory** (`./docker/config:/config:ro`) rather than individual files so `watch_reload = true` continues receiving file-change events across atomic editor saves. Linguist does not interpolate Compose environment variables into `config.toml`; set the full `[database].url` directly in `docker/config/config.toml`, and never commit real credentials or API keys to Git (`docker/config/` is gitignored).

If your JSON configs reference external `@file:` scripts (e.g. `"@file:scripts/route.js"`), place them inside `docker/config/scripts/` with `0644` (world-readable for UID `65532`) or `chown 65532:65532` + `0640`.

### 2. External PostgreSQL Requirements & TLS

- **Network reachability**: `127.0.0.1` inside the container refers to the container itself, not the host.
  - To connect to PostgreSQL running on the host: uncomment `extra_hosts: ["host.docker.internal:host-gateway"]` in [compose.yaml](compose.yaml), configure PostgreSQL `listen_addresses` and `pg_hba.conf` to accept container connections, and use `host.docker.internal` in `[database].url`.
  - To connect to PostgreSQL in another Docker network, attach the service to that shared network or use its reachable IP/DNS name.
  - Percent-encode special characters in database credentials (e.g. `@` -> `%40`, `:` -> `%3A`).
- **Database & permissions**:
  - Superuser is **not** required. Linguist runs embedded SQL migrations automatically on startup (`request_logs`, `request_payloads`, `daily_model_stats`, `system_events`).
  - If the target database does not exist yet, Linguist attempts to connect to the `postgres` maintenance database and run `CREATE DATABASE`. On managed/restricted PostgreSQL instances without `CREATEDB` or `postgres` maintenance DB access, pre-create the database and grant schema ownership or `CREATE` + DML privileges on `public` (required on PostgreSQL 15+).
- **TLS & system / private CA**:
  - Both upstream HTTPS (`reqwest`) and PostgreSQL (`sqlx`) bundle Mozilla WebPKI roots and also read OS/environment CA stores (`SSL_CERT_FILE`, `SSL_CERT_DIR`).
  - For remote PostgreSQL over TLS, append `?sslmode=verify-full` to `[database].url`.
  - For a private CA (for upstream model APIs and/or PostgreSQL): place your CA PEM at `docker/config/certs/ca.pem` (`0644`), uncomment `SSL_CERT_FILE=/config/certs/ca.pem` in [compose.yaml](compose.yaml), or pass `?sslmode=verify-full&sslrootcert=/config/certs/pg-ca.pem` for PostgreSQL alone.
  - Note: if PostgreSQL TLS/protocol negotiation fails with a protocol error, Linguist may also attempt the fallback check against the `postgres` maintenance database; verify both TLS parameters and `pg_hba.conf` when diagnosing startup failures.

### 3. Unified CLI, Lifecycle & Operations

Because `WORKDIR` is `/config`, container commands match local binary commands directly:

```bash
# Validate TOML, JSON catalogs, @file scripts, and TS/JS compilation offline
docker compose run --rm linguist check-config

# Start in background (reads /config/config.toml)
docker compose up -d

# Check logs & health
docker compose logs -f linguist
curl -fsS http://127.0.0.1:9527/healthz

# Update / rollback by changing the pinned image tag or digest in compose.yaml
docker compose pull
docker compose up -d
```

- `scratch` has no shell or `curl`, so container health is probed externally via `/healthz` (returns HTTP `200` with `{"database":"ok",...}` when PostgreSQL is reachable, or `503` otherwise).
- If PostgreSQL is unavailable at startup, Linguist exits and Compose restarts it per `restart: unless-stopped`; backing up the external database, configuration files, and rotated logs is managed outside Compose.

## API Endpoints

All model traffic is project-scoped. The project ID is part of the URL and the request must carry
that project's `apiKey` (required for every project in `projects.json`) as a Bearer token:

```text
GET  /model/{project_id}/v1/models
POST /model/{project_id}/v1/chat/completions
Authorization: Bearer <project apiKey>
```

```bash
curl https://linguist.example.com/model/default/v1/chat/completions \
  -H "Authorization: Bearer <apiKey>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"hi"}]}'
```

- Unknown projects, wrong keys and missing keys all return `401`.
- `/models` lists exactly the project's declared `callModels`.
- Downstream clients can only call models declared in the project's `callModels`; every request
  goes through that project's route rule to an upstream provider. Wildcard (`"*"`) or undeclared
  call models are not supported (a `"*"` callModel id is rejected when the config loads).
- The legacy `/v1/*`, `/g/{project}/v1/*` and `/p/{provider}/v1/*` endpoints were removed and
  return `404`.

# Linguist

Programmable script-routed `OpenAI` Chat API gateway with a token telemetry dashboard and a read-only configuration console, built with Rust, PostgreSQL, and React.

## Quick Commands

```powershell
# Build the embedded UI before the first Cargo build in a fresh checkout
npm --prefix frontend ci
npm --prefix frontend run build

# Check the JSON configuration and pre-compile all 5-stage TS/JS scripts
cargo run -- check-config

# Seed 180 days of demo telemetry into PostgreSQL
cargo run -- seed-demo --days 180

# Generate once; persist the master key and reuse it on restart and across instances.
$env:LINGUIST_CATALOG_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:LINGUIST_CATALOG_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
cargo run -- serve
```

Open `http://127.0.0.1:9527/`. The sidebar keeps telemetry separate from the five configuration tables. Each row's **编辑** action opens a read-only form with a locally bundled Monaco editor; there is no write API. The embedded UI serves dependency licenses at `/third-party-notices.txt`.

### Configuration in PostgreSQL

- `[configs].source = "json_sync"` (or the legacy `"json_files"`) imports all three JSON catalogs and resolved `@file:` scripts at startup. With `watch_reload = true`, file events and a 10-second recheck trigger validated, all-or-nothing replacements. Invalid changes preserve the last committed version. To change several files together, stop the importer or disable its watcher before editing, then restart it after all files are ready.
- The gateway and configuration pages read PostgreSQL, not the import files. The gateway swaps complete in-memory snapshots after a commit, without interrupting active requests. Run one JSON importer per database and set other instances to `source = "postgres"` after the first import.
- `LINGUIST_CATALOG_KEY` is a shared 32-byte random hex key. Back it up separately from the database; it protects upstream credentials and verifies existing project credentials. `LINGUIST_CATALOG_TOKEN` unlocks only the configuration console. Keep it separate from project API keys. If unset, model traffic and telemetry still work, but catalog access is disabled.
- When ready to remove the files, verify the last sync, run `cargo run -- disable-json-sync`, and set `[configs].source = "postgres"` on every instance. The database rejects subsequent JSON imports. No files are deleted by the command.

SVG icons from the MIT-licensed LobeHub icon pack are included in the executable and served read-only at `/icons/{slug}.svg`. The embedded pack works in local and Docker deployments without runtime downloads or a mounted icon directory; unknown icons use the dashboard monogram fallback. The upstream license is included at [icons/lobe/LICENSE](icons/lobe/LICENSE).

## Docker Deployment (External PostgreSQL)

Linguist provides a pure-binary `scratch` multi-arch container image (`linux/amd64` and `linux/arm64`) published to:

```text
ghcr.io/preca-hoshino/linguist
```

- The container image contains only `/linguist` and the empty `/config` mount point (`WORKDIR /config`, running as non-root `65532:65532`).
- [compose.yaml](compose.yaml) runs only the `linguist` service and does **not** create a PostgreSQL container or data volumes. You must provide an external PostgreSQL instance.
- Production deployments should pin an explicit version tag (matching the GitHub Release, e.g. `v0.1.0-b12-abcdef`) or `@sha256:...` digest via `LINGUIST_TAG` in `.env` instead of `:latest`.

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

Set `LINGUIST_CATALOG_KEY` in the deployment environment or the ignored root `.env`. Set a separate `LINGUIST_CATALOG_TOKEN` if you want to enable the configuration console. Generate each independently, for example with `openssl rand -hex 32`. Do not regenerate the master key on redeploy. If upgrading an existing installation with its own Compose file, pass the variables through to the `linguist` service:

```yaml
environment:
  LINGUIST_CATALOG_KEY: ${LINGUIST_CATALOG_KEY:-}
  LINGUIST_CATALOG_TOKEN: ${LINGUIST_CATALOG_TOKEN:-}
```

### 2. External PostgreSQL Requirements & TLS

- **Network reachability**: `127.0.0.1` inside the container refers to the container itself, not the host.
  - To connect to PostgreSQL running on the host: [compose.yaml](compose.yaml) enables `extra_hosts: ["host.docker.internal:host-gateway"]`, configure PostgreSQL `listen_addresses` and `pg_hba.conf` to accept container connections, and use `host.docker.internal` in `[database].url`.
  - To connect to PostgreSQL in another Docker network, attach the service to that shared network or use its reachable IP/DNS name.
  - Percent-encode special characters in database credentials (e.g. `@` -> `%40`, `:` -> `%3A`).
- **Database & permissions**:
  - Superuser is **not** required. Linguist runs embedded SQL migrations for the catalog and telemetry automatically on startup.
  - If the target database does not exist yet, Linguist attempts to connect to the `postgres` maintenance database and run `CREATE DATABASE`. On managed/restricted PostgreSQL instances without `CREATEDB` or `postgres` maintenance DB access, pre-create the database and grant schema ownership or `CREATE` + DML privileges on `public` (required on PostgreSQL 15+).
- **TLS & system / private CA**:
  - Both upstream HTTPS (`reqwest`) and PostgreSQL (`sqlx`) bundle Mozilla WebPKI roots and also read OS/environment CA stores (`SSL_CERT_FILE`, `SSL_CERT_DIR`).
  - For remote PostgreSQL over TLS, append `?sslmode=verify-full` to `[database].url`.
  - For a private CA (for upstream model APIs and/or PostgreSQL): place your CA PEM at `docker/config/certs/ca.pem` (`0644`), uncomment `SSL_CERT_FILE: /config/certs/ca.pem` in [compose.yaml](compose.yaml), or pass `?sslmode=verify-full&sslrootcert=/config/certs/pg-ca.pem` for PostgreSQL alone.
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

# Update / rollback by changing LINGUIST_TAG in .env (or pinned image tag/digest)
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

### Configuration console API

Use `Authorization: Bearer <LINGUIST_CATALOG_TOKEN>` on the same origin. Catalog lists include configurations that have never received traffic.

- `GET /api/v1/catalog/{resource}` — `providers`, `provider-models`, `projects`, `project-models`, or `routes`. Lists support `q`, `page`, and `page_size`. Models accept `provider_id` or `project_id` for their parent; routing accepts `project_id` and `call_model_id` to identify the first matching enabled rule without executing scripts.
- `GET /api/v1/catalog/{resource}/detail?id=…` — add the parent ID for either model resource. Details expose script source and configuration fields to the console operator, never the dedicated API key values. Endpoint userinfo, query strings and fragments are omitted. Keep secrets out of script source and metadata.
- `GET /api/v1/catalog/status` — committed revision, this instance's loaded revision, and the latest sync error, if any. Use this to verify a final sync before removing JSON.

Run the catalog integration tests with `cargo test --locked --test catalog_e2e -- --ignored` and a `DATABASE_URL` pointing at a disposable PostgreSQL server where the test role may create databases.

### Per-endpoint retries

Route targets and fallbacks may set `maxAttempts` to an integer from 1 to 5. It includes the
initial request and defaults to 1 when omitted. Route scripts may set it per endpoint:

```typescript
ctx.route.target = { providerId: "primary", modelId: "model-id", maxAttempts: 2 };
ctx.route.fallbacks = [{ providerId: "backup", modelId: "model-id" }];
```

Each request starts with the primary target. Transport failures and HTTP statuses listed in
`script_engine.fallback_status_codes` trigger the next attempt; after the response starts, it is
not retried. Model/provider script failures can also move to the next attempt. Attempts rerun the
model and provider stages from the route snapshot. Repeated entries for the same provider/model
are deduplicated; use `maxAttempts` instead to retry an endpoint.

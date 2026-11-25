# Linguist

Programmable script-routed `OpenAI` Chat API gateway with a token telemetry dashboard, paginated request logs, and an online read-write configuration console, built with Rust, PostgreSQL, and React.

## Quick Commands

```powershell
# Build the embedded UI before the first Cargo build in a fresh checkout
npm --prefix frontend ci
npm --prefix frontend run build

# Validate the PostgreSQL catalog and compile all 5-stage TS/JS script chains
cargo run -- check-config

# Dry-run the 5-stage routing & request script pipeline
cargo run -- dry-run --project-id default --model deepseek-v4-pro

# Seed 180 days of demo telemetry into PostgreSQL
cargo run -- seed-demo --days 180

# Generate once; persist the master key and reuse it on restart and across instances.
$env:LINGUIST_CATALOG_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:LINGUIST_OIDC_ADMIN_SUB = "your-oidc-admin-sub"
cargo run -- serve
```

Open `http://127.0.0.1:9527/`. The sidebar keeps telemetry overview (`/`), multi-dimensional monitoring (`/data`), and paginated request logs (`/logs`) separate from the five configuration tables (`providers`, `provider-models`, `projects`, `project-models`, `routes`). Each catalog item uses ordered TypeScript/JavaScript script units (`scripts[]`) edited in a locally bundled Monaco editor with `linguist.d.ts` IntelliSense. The embedded UI serves dependency licenses at `/third-party-notices.txt`.

`[server].upstream_timeout_secs` (minimum 5 seconds) limits connection establishment and upstream read inactivity. Streaming responses can continue beyond this duration while data arrives; non-streaming requests also retain a total deadline. Reverse proxies in front of Linguist must allow sufficient idle time for SSE responses.

### Configuration in PostgreSQL

- **PostgreSQL is the sole configuration source.** All five catalog dimensions (`providers`, `provider-models`, `projects`, `project-models`, `routes`) are stored in PostgreSQL and managed via the OIDC + CSRF protected Web Console or API.
- The gateway compiles and validates all script chains on load and swaps complete in-memory `ArcSwap` snapshots atomically without interrupting active requests.
- `LINGUIST_CATALOG_KEY` is a shared 32-byte random hex key. Back it up separately from the database; it encrypts upstream provider credentials with ChaCha20-Poly1305 AEAD. Project API keys are stored in plaintext on `catalog_projects.api_key` and compared in constant time.
- Console and telemetry access (`/api/v1/stats/*`, `/api/v1/catalog/*`, `/api/v1/billing/*`) is protected by OIDC Authorization Code + PKCE login (`[oidc]` in `config.toml`, client secret in `client_secret_file`, and `LINGUIST_OIDC_ADMIN_SUB` for exact admin `sub` matching) with an 8-hour `HttpOnly` session cookie.

### Cost tracking (`onBilling`)

- Pricing is authored in `Provider` and `ProviderModel` `onBilling(b)` scripts (with `rust_decimal`-backed helpers `linguist.costPerMillion`, `decAdd`, `decSub`, `decMul`, and `tierBilling`).
- Expenses are calculated asynchronously after upstream completion and stored per upstream attempt in their original currency (`billing_amount`, `billing_currency`, `billing_status`, `billing_details`).
- Optionally set `[billing] display_currency = "CNY"` in TOML. The server retrieves reference rates from Frankfurter every six hours and keeps the last available rate per currency in PostgreSQL (`api.frankfurter.dev`). Unavailable or stale pairs remain in original currency.

SVG icons from the MIT-licensed LobeHub icon pack are included in the executable and served read-only at `/icons/{slug}.svg`. Unknown icons use the dashboard monogram fallback. The upstream license is included at [icons/lobe/LICENSE](icons/lobe/LICENSE).

## Docker Deployment (External PostgreSQL)

Linguist provides a pure-binary `scratch` multi-arch container image (`linux/amd64` and `linux/arm64`) published to:

```text
ghcr.io/preca-hoshino/linguist
```

- The container image contains only `/linguist` and the empty `/config` mount point (`WORKDIR /config`, running as non-root `65532:65532`).
- [compose.yaml](compose.yaml) runs only the `linguist` service and does **not** create a PostgreSQL container or data volumes. You must provide an external PostgreSQL instance.
- Production deployments should pin an explicit version tag (matching the GitHub Release, e.g. `v0.2.1-b...`) or `@sha256:...` digest via `LINGUIST_TAG` in `.env` instead of `:latest`.

### 1. Prepare Host Config Directory

```bash
mkdir -p docker/config/secrets
cp config.docker.example.toml docker/config/config.toml
chmod 755 docker/config docker/config/secrets
chmod 644 docker/config/config.toml
```

Set `LINGUIST_CATALOG_KEY` and `LINGUIST_OIDC_ADMIN_SUB` in the deployment environment or `.env`. Generate `LINGUIST_CATALOG_KEY` with `openssl rand -hex 32` and do not regenerate it on redeploy. Configure `[oidc]` in `docker/config/config.toml` and place the OIDC client secret in `docker/config/secrets/oidc-client-secret` (readable by UID `65532`).

### 2. External PostgreSQL Requirements & TLS

- **Network reachability**: `127.0.0.1` inside the container refers to the container itself, not the host. Use `host.docker.internal` (with `extra_hosts` in [compose.yaml](compose.yaml)) or attach to a shared Docker network.
- **Database & permissions**: Superuser is **not** required. Linguist runs embedded SQL migrations automatically on startup.
- **TLS & system / private CA**: Both upstream HTTPS (`reqwest`) and PostgreSQL (`sqlx`) bundle Mozilla WebPKI roots and read `SSL_CERT_FILE` / `SSL_CERT_DIR`.

### 3. Unified CLI, Lifecycle & Operations

```bash
# Validate PostgreSQL catalog and TS/JS script compilation offline
docker compose run --rm linguist check-config

# Start in background (reads /config/config.toml)
docker compose up -d

# Check logs & health
docker compose logs -f linguist
curl -fsS http://127.0.0.1:9527/healthz
```

## API Endpoints

All model traffic is project-scoped:

```text
GET  /model/{project_id}/v1/models
POST /model/{project_id}/v1/chat/completions
Authorization: Bearer <project apiKey>
```

- Unknown projects, wrong keys, and missing keys all return `401`.
- `/models` lists the project's enabled `callModels`.
- Run the PostgreSQL catalog integration tests with `cargo test --locked --test catalog_e2e -- --ignored` and `DATABASE_URL` pointing at a disposable PostgreSQL server.

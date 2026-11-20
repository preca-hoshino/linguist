# Linguist

Programmable script-routed `OpenAI` Chat API gateway and read-only token telemetry dashboard built with Rust, PostgreSQL, and React.

## Quick Commands

```powershell
# Check config and pre-compile all 5-stage TS/JS scripts
cargo run -- check-config

# Download LobeHub SVG icon pack
cargo run -- sync-icons

# Seed 180 days of demo telemetry into PostgreSQL
cargo run -- seed-demo --days 180

# Start gateway & embedded telemetry dashboard on http://127.0.0.1:9527
cargo run -- serve
```

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

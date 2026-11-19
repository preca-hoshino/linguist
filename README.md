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

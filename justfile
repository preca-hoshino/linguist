# Justfile for Linguist
# Mirrors shu-mcp verification gates and frontend build integration.

set shell := ["powershell", "-c"]

default:
    @just --list

# [dev] Run gateway + dashboard in dev mode
dev:
    cargo run -- serve

# [build] Build frontend bundle and release Rust binary
build:
    cd frontend; npm run build
    cargo build --release

# [check-format] Verify Rust formatting
check-format:
    cargo fmt --all -- --check

# [check-lint] Run strict Clippy and ESLint checks
check-lint:
    cargo clippy --all-targets --all-features -- -D warnings
    cd frontend; npm run lint

# [check-types] Run Rust typecheck and TypeScript strict check
check-types:
    cargo check --all-targets --all-features
    cd frontend; npm run typecheck

# [check-deps] Check unused Cargo dependencies (requires cargo-machete)
check-deps:
    cargo machete

# [check-test] Run all Rust unit & integration tests and frontend production build
check-test:
    cd frontend; npm run build
    cargo test --locked

# [check] Mandatory pre-commit / CI verification pipeline
check:
    @just check-format
    @just check-lint
    @just check-types
    @just check-deps
    @just check-test

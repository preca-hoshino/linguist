# Linguist Windows native verification gate script (equivalent to `just check`)
$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Label,
        [scriptblock]$Action
    )
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Label (exit code $LASTEXITCODE)"
    }
}

Invoke-Step "check-format: cargo fmt --all -- --check" {
    cargo fmt --all -- --check
}

Invoke-Step "check-types (frontend): npm run typecheck" {
    Push-Location frontend
    try { npm run typecheck } finally { Pop-Location }
}

Invoke-Step "check-lint (frontend): npm run lint" {
    Push-Location frontend
    try { npm run lint } finally { Pop-Location }
}

Invoke-Step "build (frontend): npm run build" {
    Push-Location frontend
    try { npm run build } finally { Pop-Location }
}

Invoke-Step "check-types (rust): cargo check --all-targets --all-features" {
    cargo check --all-targets --all-features
}

Invoke-Step "check-lint (rust): cargo clippy --all-targets --all-features -- -D warnings" {
    cargo clippy --all-targets --all-features -- -D warnings
}

if (Get-Command cargo-machete -ErrorAction SilentlyContinue) {
    Invoke-Step "check-deps: cargo machete" {
        cargo machete
    }
} else {
    Write-Host "==> check-deps: cargo-machete not installed, skipping optional local dep scan" -ForegroundColor Yellow
}

Invoke-Step "check-test: cargo test --locked" {
    cargo test --locked
}

Write-Host "ALL CHECKS PASSED" -ForegroundColor Green

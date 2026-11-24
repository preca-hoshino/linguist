CREATE TABLE IF NOT EXISTS oidc_identities (
    id UUID PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY,
    token_hash BYTEA NOT NULL UNIQUE,
    identity_id UUID NOT NULL REFERENCES oidc_identities(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
    ON admin_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_issuer_subject
    ON admin_sessions (issuer, subject);

CREATE TABLE IF NOT EXISTS oidc_login_transactions (
    id UUID PRIMARY KEY,
    state_hash BYTEA NOT NULL UNIQUE,
    nonce TEXT NOT NULL,
    pkce_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oidc_login_transactions_expires_at
    ON oidc_login_transactions (expires_at);

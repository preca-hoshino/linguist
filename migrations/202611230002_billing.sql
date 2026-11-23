ALTER TABLE catalog_state
    ADD COLUMN billing_prices JSONB,
    ADD COLUMN billing_fx_rates JSONB;

ALTER TABLE request_logs
    ADD COLUMN billing_amount NUMERIC,
    ADD COLUMN billing_currency TEXT,
    ADD COLUMN billing_status TEXT,
    ADD COLUMN billing_details JSONB;

CREATE INDEX IF NOT EXISTS idx_request_logs_parent_attempt
    ON request_logs (parent_request_uid, attempt_index);

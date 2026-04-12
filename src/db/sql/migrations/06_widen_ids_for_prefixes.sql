-- Linguist LLM Gateway — Migration: 06_widen_ids_for_prefixes
-- Description: Widen ID columns from VARCHAR(8) to VARCHAR(32) to support Stripe-like prefixes
-- (e.g. app_a1b2c3d4, pm_a1b2c3d4). Existing 8-char IDs remain valid.

BEGIN;

-- 1. users table
ALTER TABLE users ALTER COLUMN id TYPE VARCHAR(32);

-- 2. providers & provider_models
ALTER TABLE providers ALTER COLUMN id TYPE VARCHAR(32);

ALTER TABLE provider_models ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE provider_models ALTER COLUMN provider_id TYPE VARCHAR(32);

-- 3. virtual_model_backends
ALTER TABLE virtual_model_backends ALTER COLUMN provider_model_id TYPE VARCHAR(32);

-- 4. apps, api_keys, app_allowed_models
ALTER TABLE apps ALTER COLUMN id TYPE VARCHAR(32);

ALTER TABLE app_allowed_models ALTER COLUMN app_id TYPE VARCHAR(32);

ALTER TABLE IF EXISTS api_keys ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE IF EXISTS api_keys ALTER COLUMN app_id TYPE VARCHAR(32);

-- 5. request_logs (foreign key to providers)
-- Note: PostgreSQL partitioned tables automatically propagate ALTER COLUMN to partitions
ALTER TABLE request_logs ALTER COLUMN provider_id TYPE VARCHAR(32);

COMMIT;

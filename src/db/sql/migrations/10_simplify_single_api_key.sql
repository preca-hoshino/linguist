BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Step 1: Add the singular api_key column (allows null temporarily for migration)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS api_key VARCHAR(100);

-- Step 2: Migrate data from the old api_keys table if it exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_keys') THEN
    UPDATE apps a
    SET api_key = COALESCE(
      (
        SELECT ak.key_value
        FROM api_keys ak
        WHERE ak.app_id = a.id AND ak.is_active = true
        ORDER BY ak.created_at ASC
        LIMIT 1
      ), 
      'lk-' || encode(gen_random_bytes(24), 'hex')
    );
  END IF;
END $$;

-- Step 3: For apps that didn't get an api_key (e.g. no active old keys, or api_keys table didn't exist)
UPDATE apps
SET api_key = 'lk-' || encode(gen_random_bytes(24), 'hex')
WHERE api_key IS NULL;

-- Step 4: Enforce UNIQUE NOT NULL constraints
ALTER TABLE apps ALTER COLUMN api_key SET NOT NULL;
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'apps_api_key_key'
  ) THEN
    ALTER TABLE apps ADD CONSTRAINT apps_api_key_key UNIQUE(api_key);
  END IF;
END $$;

-- Step 5: Update request_logs to replace api_key_prefix with app_id
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='api_key_prefix') THEN
    ALTER TABLE request_logs RENAME COLUMN api_key_prefix TO app_id;
    ALTER TABLE request_logs ALTER COLUMN app_id TYPE VARCHAR(32);
  END IF;
END $$;

-- Step 6: Drop the old table entirely
DROP TABLE IF EXISTS api_keys CASCADE;

COMMIT;

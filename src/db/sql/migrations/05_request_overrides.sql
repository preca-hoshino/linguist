BEGIN;

ALTER TABLE model_provider_models
  ADD COLUMN IF NOT EXISTS request_overrides JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN model_provider_models.request_overrides IS 'Request rewrite rules: {"headers":{"Key":"value"|null},"body":{"key":"value"|null}}. null = delete field.';

COMMIT;

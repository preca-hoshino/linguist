BEGIN;

-- 1. apps 删除 auth_mode
ALTER TABLE apps
  DROP COLUMN IF EXISTS auth_mode;

-- 3. model_provider_models 删除 parameters
ALTER TABLE model_provider_models
  DROP COLUMN IF EXISTS parameters;

-- 4. request_logs_details 删除 cost_breakdown
ALTER TABLE request_logs_details
  DROP COLUMN IF EXISTS cost_breakdown;

-- 5. request_logs 删除 Token 及冗余相关字段
ALTER TABLE request_logs
  DROP COLUMN IF EXISTS prompt_tokens,
  DROP COLUMN IF EXISTS completion_tokens,
  DROP COLUMN IF EXISTS total_tokens,
  DROP COLUMN IF EXISTS cached_tokens,
  DROP COLUMN IF EXISTS reasoning_tokens;

COMMIT;

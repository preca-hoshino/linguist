BEGIN;

-- 1. model_provider_models 新增独立 API 超时时间字段
ALTER TABLE model_provider_models
  ADD COLUMN IF NOT EXISTS timeout_ms INTEGER DEFAULT NULL;

COMMENT ON COLUMN model_provider_models.timeout_ms IS 'API request timeout in milliseconds. NULL = use system default (DEFAULT_PROVIDER_TIMEOUT).';

-- 2. model_providers 新增提供商级别的并发限制字段
ALTER TABLE model_providers
  ADD COLUMN IF NOT EXISTS rpm_limit INTEGER DEFAULT NULL;

ALTER TABLE model_providers
  ADD COLUMN IF NOT EXISTS tpm_limit INTEGER DEFAULT NULL;

COMMENT ON COLUMN model_providers.rpm_limit IS 'Provider-level RPM limit shared across all virtual models using this provider. NULL = no limit.';
COMMENT ON COLUMN model_providers.tpm_limit IS 'Provider-level TPM limit shared across all virtual models using this provider. NULL = no limit.';

COMMIT;

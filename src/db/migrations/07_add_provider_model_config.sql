-- src/db/migrations/07_add_provider_model_config.sql
-- 为 provider_models 表新增 model_config JSONB 列
-- 用途：存储提供商模型级专属运行时配置（如 Copilot 端点覆盖、特殊 Header 等）

BEGIN;

ALTER TABLE provider_models
  ADD COLUMN IF NOT EXISTS model_config JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN provider_models.model_config IS
  '提供商模型级专属配置（提供商特化参数，如 Copilot 端点覆盖、特殊 Header 等）';

COMMIT;

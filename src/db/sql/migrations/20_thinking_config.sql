-- 20_thinking_config.sql — 思考配置：提供商模型 + 虚拟模型
--
-- 为 model_provider_models 和 virtual_models 新增 thinking_config JSONB 列，
-- 统一存储思考开关、effort 级别表、reasoning_content 回填配置。
-- 同时将 model_config 中的 reasoning_content_backfill 迁移到新列。

-- 1. 提供商模型新增思考配置列
ALTER TABLE model_provider_models
  ADD COLUMN IF NOT EXISTS thinking_config JSONB DEFAULT NULL;

COMMENT ON COLUMN model_provider_models.thinking_config IS
  'Thinking configuration for this provider model.
   Structure: {"enabled":true,"reasoning_content_backfill":true,"levels":[{"name":"high","ratio":0.40}]}.
   NULL = no thinking support configured.';

-- 2. 虚拟模型新增思考配置列
ALTER TABLE virtual_models
  ADD COLUMN IF NOT EXISTS thinking_config JSONB DEFAULT NULL;

COMMENT ON COLUMN virtual_models.thinking_config IS
  'Override thinking configuration for this virtual model.
   NULL = inherit from provider model.';

-- 3. 数据迁移：将 model_config 中的 reasoning_content_backfill 迁移到 thinking_config
UPDATE model_provider_models
SET thinking_config = jsonb_build_object(
  'enabled', 'thinking' = ANY(capabilities),
  'reasoning_content_backfill', COALESCE((model_config->>'reasoning_content_backfill')::boolean, false)
)
WHERE model_config ? 'reasoning_content_backfill';

-- 4. 清理：从 model_config 中移除已迁移的 reasoning_content_backfill 字段
UPDATE model_provider_models
SET model_config = model_config - 'reasoning_content_backfill'
WHERE model_config ? 'reasoning_content_backfill';

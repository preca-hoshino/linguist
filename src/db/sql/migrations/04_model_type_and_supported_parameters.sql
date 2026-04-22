BEGIN;

-- 1. 扩充 model_type 枚举约束（provider models）
ALTER TABLE model_provider_models
  DROP CONSTRAINT IF EXISTS model_provider_models_model_type_check;
ALTER TABLE model_provider_models
  ADD CONSTRAINT model_provider_models_model_type_check
    CHECK (model_type IN ('chat', 'embedding', 'rerank', 'image', 'audio'));

-- 2. 新增 supported_parameters 字段
ALTER TABLE model_provider_models
  ADD COLUMN IF NOT EXISTS supported_parameters TEXT[] DEFAULT '{}';

-- 3. 扩充 model_type 枚举约束（virtual models）
ALTER TABLE virtual_models
  DROP CONSTRAINT IF EXISTS virtual_models_model_type_check;
ALTER TABLE virtual_models
  ADD CONSTRAINT virtual_models_model_type_check
    CHECK (model_type IN ('chat', 'embedding', 'rerank', 'image', 'audio'));

-- 4. 数据补填：为现有 chat 类型 model 在 capabilities 中追加 'stream'
UPDATE model_provider_models
SET capabilities = array_append(capabilities, 'stream')
WHERE model_type = 'chat'
  AND NOT ('stream' = ANY(capabilities));

COMMIT;

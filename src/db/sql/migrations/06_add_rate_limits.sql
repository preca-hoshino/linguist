-- Linguist LLM Gateway — 06: 提供商模型与虚拟模型流控限制
-- 为 provider_models 和 virtual_models 添加 RPM/TPM 限制字段

BEGIN;

-- ==================== 提供商模型：上游资产保护 ====================
ALTER TABLE provider_models
  ADD COLUMN IF NOT EXISTS rpm_limit INT DEFAULT NULL,    -- 每分钟请求数上限（NULL = 不限制）
  ADD COLUMN IF NOT EXISTS tpm_limit INT DEFAULT NULL;    -- 每分钟 Token 数上限（NULL = 不限制）

-- ==================== 虚拟模型：宏观隔离防护 ====================
ALTER TABLE virtual_models
  ADD COLUMN IF NOT EXISTS rpm_limit INT DEFAULT NULL,    -- 每分钟请求数上限（NULL = 不限制）
  ADD COLUMN IF NOT EXISTS tpm_limit INT DEFAULT NULL;    -- 每分钟 Token 数上限（NULL = 不限制）

COMMIT;

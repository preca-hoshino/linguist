-- Linguist LLM Gateway — 三层模型架构迁移
-- Provider → ProviderModel → VirtualModel（含多后端路由策略）
-- 全幂等：所有对象均使用 IF NOT EXISTS，可安全重跑

BEGIN;

-- ==================== 提供商表 ====================
CREATE TABLE IF NOT EXISTS providers (
    id          VARCHAR(8)   PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    kind        VARCHAR(50)  NOT NULL,             -- 协议类型: 'openai', 'claude', 'gemini', 'deepseek', 'dashscope', 'openrouter'
    base_url    TEXT         NOT NULL,              -- API 基地址
    api_key     TEXT         NOT NULL,              -- API 密钥
    config      JSONB        DEFAULT '{}'::jsonb,   -- 额外配置 (如 organization_id)
    is_active   BOOLEAN      DEFAULT true,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 提供商模型表 ====================
CREATE TABLE IF NOT EXISTS provider_models (
    id              VARCHAR(8)   PRIMARY KEY,
    provider_id     VARCHAR(8)   NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,           -- 厂商侧真实模型名
    model_type      VARCHAR(20)  NOT NULL CHECK (model_type IN ('chat', 'embedding')),
    capabilities    TEXT[]       DEFAULT '{}',        -- 能力标签(chat): vision | web_search | thinking | tools
    parameters      JSONB        DEFAULT '{}'::jsonb, -- 参数描述: max_tokens, context_window ...
    is_active       BOOLEAN      DEFAULT true,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE(provider_id, name)
);

-- ==================== 虚拟模型表 ====================
CREATE TABLE IF NOT EXISTS virtual_models (
    id                  VARCHAR(100) PRIMARY KEY,      -- 用户自定义 slug，如 "gpt-4o"
    name                VARCHAR(200) NOT NULL,
    description         TEXT         DEFAULT '',
    model_type          VARCHAR(20)  NOT NULL DEFAULT 'chat'
                        CHECK (model_type IN ('chat', 'embedding')),
    routing_strategy    VARCHAR(20)  NOT NULL DEFAULT 'simple'
                        CHECK (routing_strategy IN ('simple', 'load_balance', 'failover', 'round_robin')),
    is_active           BOOLEAN      DEFAULT true,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 虚拟模型后端关联表 ====================
CREATE TABLE IF NOT EXISTS virtual_model_backends (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    virtual_model_id    VARCHAR(100) NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
    provider_model_id   VARCHAR(8)   NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
    weight              INT          NOT NULL DEFAULT 1,
    priority            INT          NOT NULL DEFAULT 0,
    UNIQUE(virtual_model_id, provider_model_id)
);

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_providers_kind           ON providers(kind);
CREATE INDEX IF NOT EXISTS idx_providers_active         ON providers(is_active);
CREATE INDEX IF NOT EXISTS idx_pm_provider              ON provider_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_pm_type                  ON provider_models(model_type);
CREATE INDEX IF NOT EXISTS idx_pm_active                ON provider_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vm_active                ON virtual_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vmb_virtual_model        ON virtual_model_backends(virtual_model_id);
CREATE INDEX IF NOT EXISTS idx_vmb_provider_model       ON virtual_model_backends(provider_model_id);

-- ==================== updated_at 自动更新触发器 ====================
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_providers_updated_at ON providers;
CREATE TRIGGER trigger_providers_updated_at
    BEFORE UPDATE ON providers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_provider_models_updated_at ON provider_models;
CREATE TRIGGER trigger_provider_models_updated_at
    BEFORE UPDATE ON provider_models
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_virtual_models_updated_at ON virtual_models;
CREATE TRIGGER trigger_virtual_models_updated_at
    BEFORE UPDATE ON virtual_models
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==================== 配置变更通知触发器 ====================
CREATE OR REPLACE FUNCTION notify_config_change() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('config_channel', TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_providers_change ON providers;
CREATE TRIGGER trigger_providers_change
    AFTER INSERT OR UPDATE OR DELETE ON providers
    FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_provider_models_change ON provider_models;
CREATE TRIGGER trigger_provider_models_change
    AFTER INSERT OR UPDATE OR DELETE ON provider_models
    FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_models_change ON virtual_models;
CREATE TRIGGER trigger_virtual_models_change
    AFTER INSERT OR UPDATE OR DELETE ON virtual_models
    FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_model_backends_change ON virtual_model_backends;
CREATE TRIGGER trigger_virtual_model_backends_change
    AFTER INSERT OR UPDATE OR DELETE ON virtual_model_backends
    FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

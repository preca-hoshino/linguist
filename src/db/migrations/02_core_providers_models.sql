-- Linguist LLM Gateway — 02: 核心业务模型与路由体系
-- 包含底层各 AI 厂商、原生模型及上层的虚拟路由模型组定义

BEGIN;

-- ==================== 提供商表 ====================
CREATE TABLE IF NOT EXISTS providers (
    id              VARCHAR(8)   PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    kind            VARCHAR(50)  NOT NULL,             -- 协议类型: 'openai', 'claude', 'gemini' 等
    base_url        TEXT         NOT NULL,              -- API 基地址
    credential_type VARCHAR(20)  NOT NULL DEFAULT 'api_key', -- 鉴权方式（api_key, oauth 等）
    credential      JSONB        DEFAULT '{}'::jsonb,   -- 敏感密钥配置存储区
    config          JSONB        DEFAULT '{"enable_retry": false, "max_retries": 1, "timeout_ms": 30000, "custom_headers": {}, "http_proxy": ""}'::jsonb,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 提供商原生模型表 ====================
CREATE TABLE IF NOT EXISTS provider_models (
    id              VARCHAR(8)   PRIMARY KEY,
    provider_id     VARCHAR(8)   NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,           -- 厂商侧真实模型名
    model_type      VARCHAR(20)  NOT NULL CHECK (model_type IN ('chat', 'embedding')),
    capabilities    TEXT[]       DEFAULT '{}',        -- 能力标签: vision | web_search | thinking | tools
    parameters      JSONB        DEFAULT '{}'::jsonb, -- 参数描述结构
    max_tokens      INTEGER      DEFAULT 128,         -- 最大上限 Tokens (1K 为单位)
    pricing_tiers   JSONB        DEFAULT '[]'::jsonb, -- 计费阶梯结构数组
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
    routing_strategy    VARCHAR(20)  NOT NULL DEFAULT 'load_balance'
                        CHECK (routing_strategy IN ('load_balance', 'failover')),
    is_active           BOOLEAN      DEFAULT true,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 虚拟模型后端关联调度表 ====================
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
CREATE INDEX IF NOT EXISTS idx_pm_provider              ON provider_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_pm_type                  ON provider_models(model_type);
CREATE INDEX IF NOT EXISTS idx_pm_active                ON provider_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vm_active                ON virtual_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vmb_virtual_model        ON virtual_model_backends(virtual_model_id);
CREATE INDEX IF NOT EXISTS idx_vmb_provider_model       ON virtual_model_backends(provider_model_id);

COMMIT;

-- Linguist LLM Gateway — API Key 用户鉴权表
-- 管理用户侧 API Key，支持哈希存储、轮换、过期

BEGIN;

-- ==================== API Key 表 ====================
CREATE TABLE IF NOT EXISTS api_keys (
    id          VARCHAR(8)   PRIMARY KEY,

    -- 描述性名称（如 "Production App", "Dev Testing"）
    name        VARCHAR(200) NOT NULL,

    -- SHA-256 哈希存储（明文 key 仅在创建/轮换时返回一次）
    key_hash    TEXT         NOT NULL UNIQUE,

    -- 前缀用于列表展示和识别（如 "lk-a3b4c5d6"）
    key_prefix  VARCHAR(20)  NOT NULL,

    -- 启用/禁用
    is_active   BOOLEAN      DEFAULT true,

    -- 可选过期时间
    expires_at  TIMESTAMPTZ,

    -- 时间戳
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_ak_hash    ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ak_active  ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_ak_prefix  ON api_keys(key_prefix);

-- ==================== updated_at 自动更新触发器 ====================
DROP TRIGGER IF EXISTS trigger_api_keys_updated_at ON api_keys;
CREATE TRIGGER trigger_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==================== 配置变更通知触发器 ====================
DROP TRIGGER IF EXISTS trigger_api_keys_change ON api_keys;
CREATE TRIGGER trigger_api_keys_change
    AFTER INSERT OR UPDATE OR DELETE ON api_keys
    FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

-- Linguist LLM Gateway — 08: 应用（App）体系
-- 引入 apps 层级，api_keys 从独立资源升级为 App 子资源
-- 鉴权改为明文 key_value 存储，移除 key_hash
--
-- 幂等性保证：
--   - apps / app_allowed_models 使用 CREATE TABLE IF NOT EXISTS
--   - api_keys 只有在检测到旧列 key_hash 时才执行 DROP + 重建 + 日志清空
--   - 触发器统一用 DROP TRIGGER IF EXISTS + CREATE

BEGIN;

-- ==================== 应用表 ====================
CREATE TABLE IF NOT EXISTS apps (
    id              VARCHAR(8)   PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    icon            TEXT         DEFAULT '',
    auth_mode       VARCHAR(20)  NOT NULL DEFAULT 'api_key'
                    CHECK (auth_mode IN ('api_key')),  -- 预留字段，当前仅支持 api_key
    is_active       BOOLEAN      DEFAULT true,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 应用-虚拟模型访问白名单 ====================
CREATE TABLE IF NOT EXISTS app_allowed_models (
    app_id           VARCHAR(8)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    virtual_model_id VARCHAR(100) NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, virtual_model_id)
);

-- ==================== MCP 白名单预留 ====================
-- CREATE TABLE IF NOT EXISTS app_allowed_mcps (
--     app_id    VARCHAR(8) NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
--     mcp_id    VARCHAR(8) NOT NULL REFERENCES mcps(id) ON DELETE CASCADE,
--     PRIMARY KEY (app_id, mcp_id)
-- );

-- ==================== 检测旧表结构，仅首次迁移时执行破坏性操作 ====================
-- 当 api_keys 表仍使用旧的 key_hash 列时：
--   1. 清空请求日志（日志外键关联 api_keys，先清空防止约束冲突）
--   2. DROP 旧 api_keys 表并重建新结构
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'api_keys'
          AND column_name  = 'key_hash'
    ) THEN
        RAISE NOTICE '[08] 检测到旧 api_keys 表（含 key_hash），执行一次性迁移...';

        -- 清空请求日志（旧日志与旧 api_keys 关联，结构变更后无意义）
        TRUNCATE TABLE request_logs_details;
        TRUNCATE TABLE request_logs;

        -- 删除旧 api_keys 表（CASCADE 同步清除外键约束与触发器）
        DROP TABLE IF EXISTS api_keys CASCADE;

        RAISE NOTICE '[08] 旧 api_keys 表已销毁，请求日志已清空';
    ELSE
        RAISE NOTICE '[08] api_keys 已是新结构或尚未创建，跳过破坏性操作';
    END IF;
END $$;

-- ==================== api_keys 表（新结构，幂等） ====================
CREATE TABLE IF NOT EXISTS api_keys (
    id          VARCHAR(8)   PRIMARY KEY,
    app_id      VARCHAR(8)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name        VARCHAR(200) NOT NULL,
    key_value   TEXT         NOT NULL UNIQUE,    -- 完整明文 API Key (lk-xxx)
    key_prefix  VARCHAR(20)  NOT NULL,           -- 前缀 (lk-a3b4c5d6) 用于日志溯源
    is_active   BOOLEAN      DEFAULT true,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 索引（幂等） ====================
CREATE INDEX IF NOT EXISTS idx_apps_active      ON apps(is_active);
CREATE INDEX IF NOT EXISTS idx_ak_app_id        ON api_keys(app_id);
CREATE INDEX IF NOT EXISTS idx_ak_key_value     ON api_keys(key_value);
CREATE INDEX IF NOT EXISTS idx_ak_active        ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_ak_prefix        ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_aam_app          ON app_allowed_models(app_id);
CREATE INDEX IF NOT EXISTS idx_aam_model        ON app_allowed_models(virtual_model_id);

-- ==================== 触发器（幂等） ====================
DROP TRIGGER IF EXISTS trigger_apps_updated_at ON apps;
CREATE TRIGGER trigger_apps_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_api_keys_updated_at ON api_keys;
CREATE TRIGGER trigger_api_keys_updated_at BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_apps_change ON apps;
CREATE TRIGGER trigger_apps_change AFTER INSERT OR UPDATE OR DELETE ON apps
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_api_keys_change ON api_keys;
CREATE TRIGGER trigger_api_keys_change AFTER INSERT OR UPDATE OR DELETE ON api_keys
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_app_allowed_models_change ON app_allowed_models;
CREATE TRIGGER trigger_app_allowed_models_change AFTER INSERT OR UPDATE OR DELETE ON app_allowed_models
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

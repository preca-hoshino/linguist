-- Linguist LLM Gateway — Schema: 04 MCP Tables
-- MCP 网关领域的核心表结构（提供商 MCP、虚拟 MCP、MCP 日志）
-- 本文件需严格保持幂等性

BEGIN;

-- ==================== 提供商 MCP ====================
-- 存储真实的外部 MCP Server 连接配置
-- 网关作为客户端通过 stdio/sse/streamable_http 三种传输方式对接
-- 字段设计与 model_providers 保持对称
CREATE TABLE IF NOT EXISTS mcp_providers (
    id              VARCHAR(32)   PRIMARY KEY,
    name            VARCHAR(100)  NOT NULL,
    -- 传输类型（对应 model_providers.kind）
    kind            VARCHAR(20)   NOT NULL
                    CHECK (kind IN ('stdio', 'sse', 'streamable_http')),
    -- 网络端点（SSE/Streamable HTTP 使用；stdio 留空）
    base_url        TEXT          DEFAULT '',
    -- 认证类型（固定为 'api_key'，可扩展）
    credential_type VARCHAR(20)   NOT NULL DEFAULT 'api_key',
    -- API Key 池以 JSONB 数组形式存储（轮换注入至 {{APIKEY}} 标记位置）
    credential      JSONB         DEFAULT '[]'::jsonb,
    -- 传输配置：headers、stdio_command、stdio_args、stdio_env 等
    config          JSONB         DEFAULT '{}'::jsonb,
    is_active       BOOLEAN       DEFAULT true,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ==================== 虚拟 MCP ====================
-- 网关作为 MCP 服务端对外暴露的虚拟端点，映射到指定提供商
-- 命名与 virtual_models 保持对称
CREATE TABLE IF NOT EXISTS virtual_mcps (
    id              VARCHAR(32)   PRIMARY KEY,
    name            VARCHAR(200)  NOT NULL,
    description     TEXT          DEFAULT '',
    mcp_provider_id VARCHAR(32)   NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
    -- 启用的工具白名单（空数组表示全部开放）
    config          JSONB         DEFAULT '{}'::jsonb,
    is_active       BOOLEAN       DEFAULT true,
    created_at      TIMESTAMPTZ   DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ==================== MCP 日志 ====================
-- 记录经过网关转发的所有 MCP JSON-RPC 请求/响应（分区表）
CREATE TABLE IF NOT EXISTS mcp_logs (
    id              VARCHAR(36)   NOT NULL,
    virtual_mcp_id  VARCHAR(32),
    mcp_provider_id VARCHAR(32),
    app_id          VARCHAR(32)   REFERENCES apps(id) ON DELETE SET NULL,
    session_id      VARCHAR(100)  DEFAULT '',
    method          VARCHAR(100)  NOT NULL DEFAULT '',
    params          JSONB         DEFAULT '{}'::jsonb,
    result          JSONB         DEFAULT '{}'::jsonb,
    error           JSONB,
    duration_ms     INTEGER       DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 日志分区（与 request_logs 保持一致的分区策略）
CREATE TABLE IF NOT EXISTS mcp_logs_2026_04 PARTITION OF mcp_logs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_05 PARTITION OF mcp_logs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_06 PARTITION OF mcp_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_h2 PARTITION OF mcp_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS mcp_logs_default PARTITION OF mcp_logs DEFAULT;

-- ==================== MCP 应用白名单 ====================
CREATE TABLE IF NOT EXISTS app_allowed_mcps (
    app_id              VARCHAR(32)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    virtual_mcp_id      VARCHAR(32)   NOT NULL REFERENCES virtual_mcps(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, virtual_mcp_id)
);

-- ==================== MCP 触发器 ====================
DROP TRIGGER IF EXISTS trigger_mcp_providers_updated_at ON mcp_providers;
CREATE TRIGGER trigger_mcp_providers_updated_at BEFORE UPDATE ON mcp_providers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_virtual_mcps_updated_at ON virtual_mcps;
CREATE TRIGGER trigger_virtual_mcps_updated_at BEFORE UPDATE ON virtual_mcps FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_mcp_providers_change ON mcp_providers;
CREATE TRIGGER trigger_mcp_providers_change AFTER INSERT OR UPDATE OR DELETE ON mcp_providers FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_mcps_change ON virtual_mcps;
CREATE TRIGGER trigger_virtual_mcps_change AFTER INSERT OR UPDATE OR DELETE ON virtual_mcps FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_app_allowed_mcps_change ON app_allowed_mcps;
CREATE TRIGGER trigger_app_allowed_mcps_change AFTER INSERT OR UPDATE OR DELETE ON app_allowed_mcps FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

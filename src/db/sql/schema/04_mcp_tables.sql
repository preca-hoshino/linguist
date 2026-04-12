-- Linguist LLM Gateway — Schema: 04 MCP Tables
-- MCP 网关领域的核心表结构（提供商 MCP、虚拟 MCP、MCP 日志）
-- 本文件需严格保持幂等性

BEGIN;

-- ==================== 提供商 MCP ====================
-- 存储真实的外部 MCP Server 连接配置
-- 网关作为客户端通过 stdio/sse/streamable_http 三种传输方式对接
CREATE TABLE IF NOT EXISTS mcp_providers (
    id                VARCHAR(32)   PRIMARY KEY,
    name              VARCHAR(200)  NOT NULL,
    transport_type    VARCHAR(20)   NOT NULL
                      CHECK (transport_type IN ('stdio', 'sse', 'streamable_http')),
    -- 网络传输配置（SSE/Streamable HTTP 使用，支持 {{APIKEY}} 标记）
    endpoint_url      TEXT          DEFAULT '',
    headers           JSONB         DEFAULT '{}'::jsonb,
    -- Stdio 传输配置（支持 {{APIKEY}} 标记）
    stdio_command     TEXT          DEFAULT '',
    stdio_args        JSONB         DEFAULT '[]'::jsonb,
    stdio_env         JSONB         DEFAULT '{}'::jsonb,
    -- API Key 池（轮换注入至 {{APIKEY}} 标记位置）
    api_keys          JSONB         DEFAULT '[]'::jsonb,
    is_active         BOOLEAN       DEFAULT true,
    created_at        TIMESTAMPTZ   DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- ==================== 虚拟 MCP ====================
-- 网关作为 MCP 服务端对外暴露的虚拟端点，映射到指定提供商
CREATE TABLE IF NOT EXISTS mcp_virtual_servers (
    id                VARCHAR(32)   PRIMARY KEY,
    name              VARCHAR(200)  NOT NULL,
    description       TEXT          DEFAULT '',
    mcp_provider_id   VARCHAR(32)   NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
    -- 启用的工具白名单
    tools             JSONB         DEFAULT '[]'::jsonb,
    is_active         BOOLEAN       DEFAULT true,
    created_at        TIMESTAMPTZ   DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- ==================== MCP 日志 ====================
-- 记录经过网关转发的所有 MCP JSON-RPC 请求/响应（分区表）
CREATE TABLE IF NOT EXISTS mcp_logs (
    id                VARCHAR(36)   NOT NULL,
    virtual_mcp_id    VARCHAR(32),
    provider_mcp_id   VARCHAR(32),
    session_id        VARCHAR(100)  DEFAULT '',
    direction         VARCHAR(10)   NOT NULL DEFAULT 'inbound'
                      CHECK (direction IN ('inbound', 'outbound')),
    method            VARCHAR(100)  NOT NULL DEFAULT '',
    params            JSONB         DEFAULT '{}'::jsonb,
    result            JSONB         DEFAULT '{}'::jsonb,
    error             JSONB,
    duration_ms       INTEGER       DEFAULT 0,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 日志分区（与 request_logs 保持一致的分区策略）
CREATE TABLE IF NOT EXISTS mcp_logs_2026_04 PARTITION OF mcp_logs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_05 PARTITION OF mcp_logs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_06 PARTITION OF mcp_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_h2 PARTITION OF mcp_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS mcp_logs_default PARTITION OF mcp_logs DEFAULT;

COMMIT;

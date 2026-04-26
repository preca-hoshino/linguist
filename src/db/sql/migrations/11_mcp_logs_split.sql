-- Migration 11: MCP 日志表冷热拆分（破坏性迁移，无向后兼容）
-- 将旧版单表 mcp_logs 拆分为：
--   mcp_logs        — 窄热表（常用字段单列存储，支持索引过滤）
--   mcp_log_details — 冷宽表（完整 McpGatewayContext JSONB 快照，用于详情审计）
--
-- ⚠️  本迁移包含 DROP TABLE 操作，执行前请确认已运行：
--     npx ts-node --project tsconfig.json scripts/migrate-mcp-logs.ts
-- 或开发环境直接 npm run db:reset 跳过数据迁移。
BEGIN;

-- ==================== 清理旧表 ====================
DROP TABLE IF EXISTS mcp_logs CASCADE;

-- ==================== 新建 mcp_logs 窄热表 ====================
-- 字段设计与 request_logs 保持对称：常用过滤字段单列存储，不含 JSONB
CREATE TABLE IF NOT EXISTS mcp_logs (
    id                VARCHAR(36)   NOT NULL,
    virtual_mcp_id    VARCHAR(32)   REFERENCES virtual_mcps(id) ON DELETE SET NULL,
    mcp_provider_id   VARCHAR(32)   REFERENCES mcp_providers(id) ON DELETE SET NULL,
    app_id            VARCHAR(32)   REFERENCES apps(id) ON DELETE SET NULL,
    session_id        VARCHAR(100)  NOT NULL DEFAULT '',
    -- 请求状态：completed / error（当前单次写入，processing 保留供未来异步场景使用）
    status            VARCHAR(20)   NOT NULL DEFAULT 'completed'
                      CHECK (status IN ('processing', 'completed', 'error')),
    -- MCP JSON-RPC 方法名（tools/list / tools/call）
    method            VARCHAR(100)  NOT NULL DEFAULT '',
    -- 工具名（仅 tools/call 时填充，从 params.name 提取，便于单列索引过滤）
    tool_name         VARCHAR(200),
    -- 错误摘要（冗余至窄表，便于列表过滤，无需 JOIN 冷表）
    error_message     TEXT,
    -- 全链路耗时（ms）；NULL 表示进行中未完成
    duration_ms       INTEGER,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 分区策略与 request_logs 保持一致
CREATE TABLE IF NOT EXISTS mcp_logs_2026_04 PARTITION OF mcp_logs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_05 PARTITION OF mcp_logs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_06 PARTITION OF mcp_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS mcp_logs_2026_h2 PARTITION OF mcp_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS mcp_logs_default  PARTITION OF mcp_logs DEFAULT;

-- ==================== 新建 mcp_log_details 冷宽表 ====================
-- 存储 McpGatewayContext 完整快照（含 audit.params / audit.result / audit.error / timing）
-- 仅在详情页按 ID 点查时 JOIN，列表查询严禁 JOIN 此表
CREATE TABLE IF NOT EXISTS mcp_log_details (
    id              VARCHAR(36)   NOT NULL,
    -- McpGatewayContext 完整快照（唯一审计数据源）
    mcp_context     JSONB,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 分区策略与 mcp_logs 保持一致
CREATE TABLE IF NOT EXISTS mcp_log_details_2026_04 PARTITION OF mcp_log_details FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS mcp_log_details_2026_05 PARTITION OF mcp_log_details FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS mcp_log_details_2026_06 PARTITION OF mcp_log_details FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS mcp_log_details_2026_h2 PARTITION OF mcp_log_details FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS mcp_log_details_default  PARTITION OF mcp_log_details DEFAULT;

-- ==================== 索引 ====================
-- mcp_logs 窄表：常用列覆盖索引
CREATE INDEX IF NOT EXISTS idx_mcpl_virtual_mcp_created  ON mcp_logs(virtual_mcp_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_provider_created     ON mcp_logs(mcp_provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_app_created          ON mcp_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_status               ON mcp_logs(status);
CREATE INDEX IF NOT EXISTS idx_mcpl_method               ON mcp_logs(method);
CREATE INDEX IF NOT EXISTS idx_mcpl_tool_name            ON mcp_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcpl_created_at           ON mcp_logs(created_at DESC);

-- mcp_log_details 冷表：GIN 索引支持 JSONB 字段查询
CREATE INDEX IF NOT EXISTS idx_mcpld_mcp_context_gin ON mcp_log_details USING GIN (mcp_context);

-- ==================== updated_at 触发器 ====================
DROP TRIGGER IF EXISTS trigger_mcp_logs_updated_at ON mcp_logs;
CREATE TRIGGER trigger_mcp_logs_updated_at
  BEFORE UPDATE ON mcp_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;

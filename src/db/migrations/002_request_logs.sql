-- Linguist LLM Gateway — 请求日志表
-- 记录每一次网关请求的完整生命周期

BEGIN;

-- ==================== 请求日志表 ====================
CREATE TABLE IF NOT EXISTS request_logs (
    -- 主键：使用网关生成的请求 ID
    id              VARCHAR(36)  PRIMARY KEY,

    -- 请求状态：processing（等待提供商）→ completed / error
    status          VARCHAR(20)  NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing', 'completed', 'error')),

    -- 客户端信息
    ip              TEXT,

    -- 模型路由信息
    request_model   VARCHAR(200),
    routed_model    VARCHAR(200),
    provider_kind   VARCHAR(50),
    provider_id     VARCHAR(8)   REFERENCES providers(id) ON DELETE SET NULL,

    -- 请求/响应体（完整 JSON，仅按 ID 查询时返回）
    request_body            JSONB,
    response_body           JSONB,

    -- 审计数据：提供商原始报文 + 网关上下文快照
    provider_request_body   JSONB,   -- 发送给厂商的原始请求体
    provider_response_body  JSONB,   -- 厂商返回的原始响应体
    gateway_context         JSONB,   -- GatewayContext 统一上下文快照

    -- 错误信息
    error_message   TEXT,
    error_code      VARCHAR(50),

    -- 耗时统计（毫秒）
    timing          JSONB        DEFAULT '{}'::jsonb,

    -- Token 用量
    prompt_tokens       INT,
    completion_tokens   INT,
    total_tokens        INT,

    -- 时间戳
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_rl_status         ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_rl_request_model  ON request_logs(request_model);
CREATE INDEX IF NOT EXISTS idx_rl_provider_kind  ON request_logs(provider_kind);
CREATE INDEX IF NOT EXISTS idx_rl_created_at     ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_provider_id    ON request_logs(provider_id);

-- ==================== updated_at 自动更新触发器 ====================
DROP TRIGGER IF EXISTS trigger_request_logs_updated_at ON request_logs;
CREATE TRIGGER trigger_request_logs_updated_at
    BEFORE UPDATE ON request_logs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;

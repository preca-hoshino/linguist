-- Linguist LLM Gateway — 03: 分析审计与日志系统
-- 定义平台全局的所有访问日志、Token 统计结构与各类聚合索引

BEGIN;

-- ==================== 请求日志流水主表 ====================
CREATE TABLE IF NOT EXISTS request_logs (
    id                      VARCHAR(36)    PRIMARY KEY,
    
    status                  VARCHAR(20)    NOT NULL DEFAULT 'processing'
                            CHECK (status IN ('processing', 'completed', 'error')),
                            
    ip                      TEXT,
    
    -- 核心路由标签
    request_model           VARCHAR(200),
    routed_model            VARCHAR(200),
    provider_kind           VARCHAR(50),
    provider_id             VARCHAR(8)     REFERENCES providers(id) ON DELETE SET NULL,
    api_key_prefix          VARCHAR(11),   -- 鉴权凭证溯源前缀
    is_stream               BOOLEAN,       -- 是否触发了流式响应模式
    
    -- 网关超集安全快照：包含审计用的 Request / Response 和 Gateway 决策链路 (替代旧版本的大字段)
    gateway_context         JSONB,         
    
    -- 异常快照处理
    error_message           TEXT,
    error_code              VARCHAR(50),
    error_type              VARCHAR(20),   -- 维度划分如 'rate_limit', 'timeout', 按标准集扩展
    
    -- 全链路时间线纪要 (开始, TTFT, 结束等相对时间戳)
    timing                  JSONB          DEFAULT '{}'::jsonb,
    
    -- Token 精细统计引擎
    prompt_tokens           INT,
    completion_tokens       INT,
    total_tokens            INT,
    cached_tokens           INT,
    reasoning_tokens        INT,
    
    -- 真实财务成本引擎 (使用重构后的每百万 Token 标准记账核算)
    calculated_cost         DECIMAL(16,6)  DEFAULT 0.0,
    cost_breakdown          JSONB          DEFAULT '{}'::jsonb,
    
    created_at              TIMESTAMPTZ    DEFAULT NOW(),
    updated_at              TIMESTAMPTZ    DEFAULT NOW()
);

-- ==================== 统计面板优化联合索引 ====================
-- 指示器：基本搜索定位查询
CREATE INDEX IF NOT EXISTS idx_rl_status             ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_rl_provider_id        ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_rl_error_type         ON request_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_rl_is_stream          ON request_logs(is_stream);
CREATE INDEX IF NOT EXISTS idx_rl_created_at         ON request_logs(created_at DESC);

-- P99 面板：基于常见过滤维度的统计组合拳
CREATE INDEX IF NOT EXISTS idx_rl_status_created           ON request_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_provider_created         ON request_logs(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_routed_model_created     ON request_logs(routed_model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_apikey_created           ON request_logs(api_key_prefix, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_request_model_created    ON request_logs(request_model, created_at DESC);

COMMIT;

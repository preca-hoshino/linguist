-- Linguist LLM Gateway — 监控查询优化索引
-- 为统计分析 API 的聚合查询提供性能支撑

BEGIN;

-- ==================== 时间范围 + 维度联合索引 ====================
-- 加速 getStatsOverview / getStatsTimeSeries / getStatsBreakdown 等按时间范围 + 维度过滤的聚合查询

-- 按提供商维度查询（provider_id + 时间范围）
CREATE INDEX IF NOT EXISTS idx_rl_provider_created ON request_logs(provider_id, created_at DESC);

-- 按路由模型维度查询（routed_model + 时间范围）
CREATE INDEX IF NOT EXISTS idx_rl_routed_model_created ON request_logs(routed_model, created_at DESC);

-- 按 API Key 前缀维度查询
CREATE INDEX IF NOT EXISTS idx_rl_apikey_created ON request_logs(api_key_prefix, created_at DESC);

-- 按请求模型维度查询（虚拟模型）
CREATE INDEX IF NOT EXISTS idx_rl_request_model_created ON request_logs(request_model, created_at DESC);

-- ==================== 今日统计优化 ====================
-- 部分索引：仅索引今日数据，加速 getStatsToday 查询
-- 注意：此索引不会自动滚动，随时间推移效用递减，但 PostgreSQL 查询优化器会自动选择最优索引
CREATE INDEX IF NOT EXISTS idx_rl_created_at ON request_logs(created_at DESC);

COMMIT;

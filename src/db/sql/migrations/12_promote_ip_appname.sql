-- Migration 12: 将 ip 和 app_name 提升为 request_logs 窄热表独立列
-- 目的：消除列表查询对 request_log_details.gateway_context JSONB 的依赖
--       使前端列表页的 IP 地址列和 App 名称列无需 JOIN 冷表即可渲染
--
-- ip:       请求来源 IP（原仅写入 gateway_context，现同步写入热表）
-- app_name: 应用名称（原仅写入 gateway_context.appName，现同步写入热表）
--
-- 幂等性：ADD COLUMN IF NOT EXISTS 保证重复执行安全
-- 回填：使用 UPDATE ... FROM 从冷表 JSONB 回写历史数据（仅补 NULL 行）

BEGIN;

-- ==================== 1. 新增列 ====================
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS ip       TEXT    DEFAULT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS app_name TEXT    DEFAULT NULL;

-- ==================== 2. 历史数据回填 ====================
-- 从 request_log_details.gateway_context 中提取并回写历史数据
-- WHERE 条件：两列均为 NULL 的行（幂等保护，避免重复执行覆盖有效数据）
UPDATE request_logs r
SET
  ip       = d.gateway_context->>'ip',
  app_name = d.gateway_context->>'appName'
FROM request_log_details d
WHERE r.id = d.id
  AND r.ip IS NULL
  AND r.app_name IS NULL
  AND d.gateway_context IS NOT NULL;

-- ==================== 3. 新增辅助索引 ====================
CREATE INDEX IF NOT EXISTS idx_rl_ip       ON request_logs(ip);
CREATE INDEX IF NOT EXISTS idx_rl_app_name ON request_logs(app_name);

COMMIT;

-- Migration: 02_backfill_billing_into_gateway_context
-- 将存量日志的计费数据统一回填进 gateway_context JSONB 内的 billing 字段
--
-- 背景：
--   此前的计费结果（calculated_cost / cost_breakdown）仅保存在 request_logs 热列
--   和 request_logs_details.cost_breakdown 独立列中，gateway_context 快照缺少此信息。
--   本次重构在 ModelHttpContext 中增加了 billing 字段，使计费数据成为统一上下文
--   的一部分。本脚本负责对存量历史数据执行一次性回填，消除新旧格式差异。
--
-- 回填策略：
--   - 条件：gateway_context 不含 billing 字段 AND cost_breakdown 不为 NULL
--   - 来源：cost_breakdown 列 + request_logs 主表的 calculated_cost
--   - 目标：将 billing 对象写入 gateway_context JSONB 的顶层
--
-- 幂等性保证：
--   通过 WHERE NOT (gateway_context ? 'billing') 确保重复执行不会覆盖已有数据。
--
-- 注意：request_logs_details 为分区表，ALTER/UPDATE 会自动级联至所有子分区。

BEGIN;

UPDATE request_logs_details d
SET gateway_context = jsonb_set(
    d.gateway_context,
    '{billing}',
    jsonb_build_object(
        'calculatedCost', COALESCE(r.calculated_cost, 0),
        'costBreakdown',  d.cost_breakdown
    ),
    true  -- 若 key 不存在则创建
)
FROM request_logs r
WHERE d.id = r.id
  AND d.gateway_context IS NOT NULL
  AND d.cost_breakdown IS NOT NULL
  AND NOT (d.gateway_context ? 'billing');

COMMIT;

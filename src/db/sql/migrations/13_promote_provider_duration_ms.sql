-- Migration 13: 将 provider_duration_ms 提升为热表独立列
-- 目标：统计查询完全脱离 request_log_details 冷表
-- 此列原先通过 timing JSONB 的 providerEnd - providerStart 计算得出
-- 提升后 latencyExpr/ttftExpr/itlExpr 统一读热表列，消灭所有聚合 JOIN

BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS provider_duration_ms INTEGER;

COMMIT;

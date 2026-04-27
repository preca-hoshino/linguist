-- Migration 15: 引擎级 Vacuum 调优
-- 目标：提高 request_logs 热表的 Autovacuum 敏感度。
-- 默认的 vacuum_scale_factor 是 0.2 (20%)，对于上亿大表来说，
-- 意味着需要几千万行变更才会触发一次清理，导致可见性映射表 (VM) 严重滞后，
-- 进而导致 Index-Only Scan 频繁回表 (Heap Fetch)。
-- 将其下调到 1% (0.01)，可以更激进地更新 VM，保障覆盖索引的极限性能。

BEGIN;

-- 如果有按月分区的表，这个设置会自动应用到所有现存及新创建的分区（前提是 request_logs 是主分区表名）
ALTER TABLE request_logs SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01
);

COMMIT;

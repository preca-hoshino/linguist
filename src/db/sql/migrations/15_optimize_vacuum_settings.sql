-- Migration 15: 引擎级 Vacuum 调优
-- 目标：提高 request_logs 热表的 Autovacuum 敏感度。
-- 默认的 vacuum_scale_factor 是 0.2 (20%)，对于上亿大表来说，
-- 意味着需要几千万行变更才会触发一次清理，导致可见性映射表 (VM) 严重滞后，
-- 进而导致 Index-Only Scan 频繁回表 (Heap Fetch)。
-- 将其下调到 1% (0.01)，可以更激进地更新 VM，保障覆盖索引的极限性能。

BEGIN;

-- PostgreSQL 限制不能直接在 partitioned table 上设置 autovacuum
-- 我们通过 DO 块遍历所有现存的分区子表并为其分别设置。
-- （对于未来的新分区，如果对极致性能有要求，可以在按月建分区的脚本里带上这个参数）
DO $$
DECLARE
    partition_name text;
BEGIN
    FOR partition_name IN
        SELECT inhrelid::regclass::text
        FROM pg_inherits
        WHERE inhparent = 'request_logs'::regclass
    LOOP
        EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.01);', partition_name);
    END LOOP;
END $$;

COMMIT;

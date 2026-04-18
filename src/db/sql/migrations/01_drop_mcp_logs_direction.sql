-- Migration: 01_drop_mcp_logs_direction
-- 移除 mcp_logs 分区表中冗余的 direction 列
-- 该列在代码层始终硬编码为 'inbound'，outbound 从未实际写入，属于无效字段
--
-- 注意：PostgreSQL 对分区表执行 ALTER TABLE DROP COLUMN 会自动级联至所有子分区，
-- 无需逐一操作每个分区表。

BEGIN;

-- 移除 direction 列（自动级联至所有子分区）
ALTER TABLE mcp_logs DROP COLUMN IF EXISTS direction;

COMMIT;

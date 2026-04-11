-- Linguist LLM Gateway — 00: 一次性迁移记录表
-- 用于记录 `migrations/` 目录下哪些历史补丁已成功执行，确保不重复执行

BEGIN;

CREATE TABLE IF NOT EXISTS migration_history (
    id          SERIAL PRIMARY KEY,
    filename    VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_history_filename ON migration_history(filename);

COMMIT;

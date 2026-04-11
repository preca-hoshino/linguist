-- Linguist LLM Gateway — 08: 应用（App）体系迁移 (历史补丁)
-- 检测旧 api_keys 表（含 key_hash 列），如存在则清空日志与该表，以供 schema 中的新表定义生效

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'api_keys'
          AND column_name  = 'key_hash'
    ) THEN
        RAISE NOTICE '[08] 检测到旧 api_keys 表（含 key_hash），执行一次性迁移...';

        -- 清空请求日志（旧日志与旧 api_keys 关联，结构变更后无意义）
        TRUNCATE TABLE request_logs_details;
        TRUNCATE TABLE request_logs;

        -- 删除旧 api_keys 表（CASCADE 同步清除外键约束与触发器）
        DROP TABLE IF EXISTS api_keys CASCADE;

        RAISE NOTICE '[08] 旧 api_keys 表已销毁，请求日志已清空';
    ELSE
        RAISE NOTICE '[08] api_keys 已是新结构或尚未创建，跳过破坏性操作';
    END IF;
END $$;

COMMIT;

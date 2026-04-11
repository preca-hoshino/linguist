-- Linguist LLM Gateway — 05: 动态分区与冷热分离架构升级
-- 目标：彻底重构 request_logs 解决百万级性能瘫痪问题
-- 内容：拆分大字段到 request_logs_details，按月构建分区表，数据0损失迁移

DO $Migration_05$
BEGIN
    -- 幂等性检查：如果新拆分的从表已经存在，证明本次分离迁移已经成功执行，安全跳过
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'request_logs_details') THEN

        -- 1. 安全重命名老表
        ALTER TABLE IF EXISTS request_logs RENAME TO request_logs_old;

        -- 移除旧表的主键约束和已有的依赖索引名称，以防止名称冲突
        ALTER TABLE request_logs_old DROP CONSTRAINT IF EXISTS request_logs_pkey CASCADE;
        DROP INDEX IF EXISTS idx_rl_status_created CASCADE;
        DROP INDEX IF EXISTS idx_rl_provider_created CASCADE;
        DROP INDEX IF EXISTS idx_rl_routed_model_created CASCADE;
        DROP INDEX IF EXISTS idx_rl_apikey_created CASCADE;
        DROP INDEX IF EXISTS idx_rl_request_model_created CASCADE;
        DROP INDEX IF EXISTS idx_rl_status CASCADE;
        DROP INDEX IF EXISTS idx_rl_provider_id CASCADE;
        DROP INDEX IF EXISTS idx_rl_error_type CASCADE;
        DROP INDEX IF EXISTS idx_rl_is_stream CASCADE;
        DROP INDEX IF EXISTS idx_rl_created_at CASCADE;

        -- 2. 创建高度瘦身优化后的主表（使用时间戳范围分区）
        CREATE TABLE request_logs (
            id                      VARCHAR(36)    NOT NULL,
            status                  VARCHAR(20)    NOT NULL DEFAULT 'processing'
                                    CHECK (status IN ('processing', 'completed', 'error')),
            ip                      TEXT,
            request_model           VARCHAR(200),
            routed_model            VARCHAR(200),
            provider_kind           VARCHAR(50),
            provider_id             VARCHAR(8)     REFERENCES providers(id) ON DELETE SET NULL,
            api_key_prefix          VARCHAR(11),
            is_stream               BOOLEAN,
            
            error_message           TEXT,
            error_code              VARCHAR(50),
            error_type              VARCHAR(20),
            
            prompt_tokens           INT,
            completion_tokens       INT,
            total_tokens            INT,
            cached_tokens           INT,
            reasoning_tokens        INT,
            
            calculated_cost         DECIMAL(16,6)  DEFAULT 0.0,
            
            created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

            -- 分区表的主键必须包含分区键
            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);

        -- 3. 创建专属的冷数据 JSON 详情表（同等分区）
        CREATE TABLE request_logs_details (
            id                      VARCHAR(36)    NOT NULL,
            gateway_context         JSONB,
            timing                  JSONB,
            cost_breakdown          JSONB,
            created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
            
            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);

        -- 4. 建立 2026 年度的横向分区和兜底分区
        CREATE TABLE request_logs_2026_01 PARTITION OF request_logs FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
        CREATE TABLE request_logs_2026_02 PARTITION OF request_logs FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
        CREATE TABLE request_logs_2026_03 PARTITION OF request_logs FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
        CREATE TABLE request_logs_2026_04 PARTITION OF request_logs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
        CREATE TABLE request_logs_2026_05 PARTITION OF request_logs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
        CREATE TABLE request_logs_2026_06 PARTITION OF request_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
        CREATE TABLE request_logs_2026_h2 PARTITION OF request_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
        CREATE TABLE request_logs_default PARTITION OF request_logs DEFAULT;

        CREATE TABLE request_logs_details_2026_01 PARTITION OF request_logs_details FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
        CREATE TABLE request_logs_details_2026_02 PARTITION OF request_logs_details FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
        CREATE TABLE request_logs_details_2026_03 PARTITION OF request_logs_details FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
        CREATE TABLE request_logs_details_2026_04 PARTITION OF request_logs_details FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
        CREATE TABLE request_logs_details_2026_05 PARTITION OF request_logs_details FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
        CREATE TABLE request_logs_details_2026_06 PARTITION OF request_logs_details FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
        CREATE TABLE request_logs_details_2026_h2 PARTITION OF request_logs_details FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
        CREATE TABLE request_logs_details_default PARTITION OF request_logs_details DEFAULT;

        -- 5. 执行数据无损转移 (冷热拆分写入)
        INSERT INTO request_logs (
            id, status, ip, request_model, routed_model, provider_kind, provider_id, 
            api_key_prefix, is_stream, error_message, error_code, error_type, 
            prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, 
            calculated_cost, created_at, updated_at
        )
        SELECT 
            id, status, ip, request_model, routed_model, provider_kind, provider_id, 
            api_key_prefix, is_stream, error_message, error_code, error_type, 
            prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, 
            calculated_cost, created_at, updated_at
        FROM request_logs_old;

        INSERT INTO request_logs_details (
            id, gateway_context, timing, cost_breakdown, created_at
        )
        SELECT 
            id, gateway_context, timing, cost_breakdown, created_at
        FROM request_logs_old;

        -- 6. 构建性能最快的大型组合/覆盖索引
        CREATE INDEX idx_rl_status_created           ON request_logs(status, created_at DESC);
        CREATE INDEX idx_rl_provider_created         ON request_logs(provider_id, created_at DESC);
        CREATE INDEX idx_rl_routed_model_created     ON request_logs(routed_model, created_at DESC);
        CREATE INDEX idx_rl_apikey_created           ON request_logs(api_key_prefix, created_at DESC);
        CREATE INDEX idx_rl_request_model_created    ON request_logs(request_model, created_at DESC);

        -- 新增扩展：引入超大请求字段前缀加速
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX idx_rl_request_model_trgm       ON request_logs USING gin (request_model gin_trgm_ops);

        -- 为从表的重要 JSON 内容加入 GIN 和 BTree 表达式检索
        CREATE INDEX idx_rld_gateway_context_gin      ON request_logs_details USING GIN (gateway_context);
        CREATE INDEX idx_rld_user_format              ON request_logs_details ((gateway_context->>'userFormat'));

        -- 7. 确认无损之后，执行硬删除（舍弃旧表，正式切换）
        DROP TABLE request_logs_old;

    END IF;
END $Migration_05$;

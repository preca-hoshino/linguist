-- Linguist LLM Gateway — 10: Stripe API Standards
-- 实现 Stripe 风格的数据结构：metadata、ID 前缀升级及幂等性引擎
-- 破坏性更新预警：本脚本会强制变更所有现存 ID（追加前缀），并重新建立带 ON UPDATE CASCADE 的的外键关联

BEGIN;

-- ==================== 1. 幂等性支持 ====================
CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key VARCHAR(100) PRIMARY KEY,
    request_path    VARCHAR(255) NOT NULL,
    response_code   INTEGER NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_keys(expires_at);

-- ==================== 2. 元数据支持 ====================
-- 添加 metadata 支持
ALTER TABLE providers ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE provider_models ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE virtual_models ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- ==================== 3. 约束重构：支持 ID 更新的自动级联 ====================
-- 由于历史表可能没有定义 ON UPDATE CASCADE，在修改 Primary Key 之前，我们需重建外键

DO $$ 
DECLARE 
    r RECORD;
BEGIN
    -- 1. provider_models (FK: provider_id)
    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'provider_models' AND column_name = 'provider_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE provider_models DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE provider_models ADD CONSTRAINT provider_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE ON UPDATE CASCADE';

    -- 2. virtual_model_backends (FKs: virtual_model_id, provider_model_id)
    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'virtual_model_backends' AND column_name = 'virtual_model_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE virtual_model_backends DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE virtual_model_backends ADD CONSTRAINT virtual_model_backends_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES virtual_models(id) ON DELETE CASCADE ON UPDATE CASCADE';

    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'virtual_model_backends' AND column_name = 'provider_model_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE virtual_model_backends DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE virtual_model_backends ADD CONSTRAINT virtual_model_backends_provider_model_id_fkey FOREIGN KEY (provider_model_id) REFERENCES provider_models(id) ON DELETE CASCADE ON UPDATE CASCADE';

    -- 3. api_keys (FK: app_id)
    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'api_keys' AND column_name = 'app_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE api_keys ADD CONSTRAINT api_keys_app_id_fkey FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE';

    -- 4. app_allowed_models (FKs: app_id, virtual_model_id)
    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'app_allowed_models' AND column_name = 'app_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE app_allowed_models DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE app_allowed_models ADD CONSTRAINT app_allowed_models_app_id_fkey FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE';

    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'app_allowed_models' AND column_name = 'virtual_model_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE app_allowed_models DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE app_allowed_models ADD CONSTRAINT app_allowed_models_virtual_model_id_fkey FOREIGN KEY (virtual_model_id) REFERENCES virtual_models(id) ON DELETE CASCADE ON UPDATE CASCADE';

    -- 5. request_logs (FK: provider_id)
    FOR r IN (SELECT constraint_name FROM information_schema.key_column_usage WHERE table_name = 'request_logs' AND column_name = 'provider_id' AND constraint_catalog = current_database()) LOOP
        EXECUTE 'ALTER TABLE request_logs DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    END LOOP;
    EXECUTE 'ALTER TABLE request_logs ADD CONSTRAINT request_logs_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL ON UPDATE CASCADE';
END $$;


-- ==================== 4. 扩容列长 ====================
-- 将原先 VARCHAR(8) 等受限 ID 统一扩大，匹配加前缀后的长度需要
ALTER TABLE users ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE providers ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE provider_models ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE provider_models ALTER COLUMN provider_id TYPE VARCHAR(32);
-- virtual_models 已经是 VARCHAR(100)，无需扩大
ALTER TABLE virtual_model_backends ALTER COLUMN provider_model_id TYPE VARCHAR(32);
ALTER TABLE apps ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE api_keys ALTER COLUMN id TYPE VARCHAR(32);
ALTER TABLE api_keys ALTER COLUMN app_id TYPE VARCHAR(32);
ALTER TABLE app_allowed_models ALTER COLUMN app_id TYPE VARCHAR(32);
ALTER TABLE request_logs ALTER COLUMN provider_id TYPE VARCHAR(32);

-- ==================== 5. 在位更新遗留数据 ====================
-- 执行一次性的前缀升级补充。利用 UPDATE 修改主键时，得益于上述的 ON UPDATE CASCADE，所有关联项将自动跟进更改。
-- 在执行拼接前，请确保我们只处理无前缀的老数据，防止重复执行本脚本造成多次累加 (幂等保护)

UPDATE users SET id = 'usr_' || id WHERE id NOT LIKE 'usr_%';
UPDATE providers SET id = 'prv_' || id WHERE id NOT LIKE 'prv_%';
UPDATE provider_models SET id = 'pm_' || id WHERE id NOT LIKE 'pm_%';
UPDATE virtual_models SET id = 'vm_' || id WHERE id NOT LIKE 'vm_%';
UPDATE apps SET id = 'app_' || id WHERE id NOT LIKE 'app_%';
UPDATE api_keys SET id = 'ak_' || id WHERE id NOT LIKE 'ak_%';

COMMIT;

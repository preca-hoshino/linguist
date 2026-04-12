-- Linguist LLM Gateway — Schema: 03 Functions & Triggers
-- 定义系统所需的所有全局函数、时间戳更新器、以及基于 Postgre Listen/Notify 的网关通信触发器
-- 本文件需严格保持幂等性

BEGIN;

-- ==================== updated_at 自动更新触发器 ====================
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_users_updated_at ON users;
CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_apps_updated_at ON apps;
CREATE TRIGGER trigger_apps_updated_at BEFORE UPDATE ON apps FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS trigger_providers_updated_at ON providers;
CREATE TRIGGER trigger_providers_updated_at BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_provider_models_updated_at ON provider_models;
CREATE TRIGGER trigger_provider_models_updated_at BEFORE UPDATE ON provider_models FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_virtual_models_updated_at ON virtual_models;
CREATE TRIGGER trigger_virtual_models_updated_at BEFORE UPDATE ON virtual_models FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_request_logs_updated_at ON request_logs;
CREATE TRIGGER trigger_request_logs_updated_at BEFORE UPDATE ON request_logs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==================== 配置变更广播层 ====================
-- Gateway 依赖于 PostgreSQL 的 Pub/Sub 来刷新热缓存配置
CREATE OR REPLACE FUNCTION notify_config_change() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('config_channel', TG_TABLE_NAME || ':' || TG_OP);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_apps_change ON apps;
CREATE TRIGGER trigger_apps_change AFTER INSERT OR UPDATE OR DELETE ON apps FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_app_allowed_models_change ON app_allowed_models;
CREATE TRIGGER trigger_app_allowed_models_change AFTER INSERT OR UPDATE OR DELETE ON app_allowed_models FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();


DROP TRIGGER IF EXISTS trigger_providers_change ON providers;
CREATE TRIGGER trigger_providers_change AFTER INSERT OR UPDATE OR DELETE ON providers FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_provider_models_change ON provider_models;
CREATE TRIGGER trigger_provider_models_change AFTER INSERT OR UPDATE OR DELETE ON provider_models FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_models_change ON virtual_models;
CREATE TRIGGER trigger_virtual_models_change AFTER INSERT OR UPDATE OR DELETE ON virtual_models FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_model_backends_change ON virtual_model_backends;
CREATE TRIGGER trigger_virtual_model_backends_change AFTER INSERT OR UPDATE OR DELETE ON virtual_model_backends FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

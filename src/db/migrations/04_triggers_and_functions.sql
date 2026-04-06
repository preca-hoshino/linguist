-- Linguist LLM Gateway — 04: 数据库基础设施事件总线
-- 全局函数注册、时间戳更新器、以及基于 Postgre Listen/Notify 的网关通信

BEGIN;

-- ==================== updated_at 自动更新触发器 ====================
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 挂载基表时间触发器
DROP TRIGGER IF EXISTS trigger_users_updated_at ON users;
CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_api_keys_updated_at ON api_keys;
CREATE TRIGGER trigger_api_keys_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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

-- 挂载网关缓存监控触发器
DROP TRIGGER IF EXISTS trigger_api_keys_change ON api_keys;
CREATE TRIGGER trigger_api_keys_change AFTER INSERT OR UPDATE OR DELETE ON api_keys FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_providers_change ON providers;
CREATE TRIGGER trigger_providers_change AFTER INSERT OR UPDATE OR DELETE ON providers FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_provider_models_change ON provider_models;
CREATE TRIGGER trigger_provider_models_change AFTER INSERT OR UPDATE OR DELETE ON provider_models FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_models_change ON virtual_models;
CREATE TRIGGER trigger_virtual_models_change AFTER INSERT OR UPDATE OR DELETE ON virtual_models FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

DROP TRIGGER IF EXISTS trigger_virtual_model_backends_change ON virtual_model_backends;
CREATE TRIGGER trigger_virtual_model_backends_change AFTER INSERT OR UPDATE OR DELETE ON virtual_model_backends FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

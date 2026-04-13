-- Linguist LLM Gateway — Schema: 11 Add app_allowed_mcps
-- 新增应用程序与虚拟 MCP 的多对多映射表
-- 本文件需严格保持幂等性

BEGIN;

CREATE TABLE IF NOT EXISTS app_allowed_mcps (
    app_id              VARCHAR(32)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    virtual_mcp_id      VARCHAR(32)   NOT NULL REFERENCES virtual_mcps(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, virtual_mcp_id)
);

DROP TRIGGER IF EXISTS trigger_app_allowed_mcps_change ON app_allowed_mcps;
CREATE TRIGGER trigger_app_allowed_mcps_change
  AFTER INSERT OR UPDATE OR DELETE ON app_allowed_mcps
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_change();

COMMIT;

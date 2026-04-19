-- Linguist LLM Gateway — Migration 03: Virtual MCPs name unique constraint
-- 为 virtual_mcps.name 添加全局唯一约束
-- X-Mcp-Name header 路由依赖 name 的全局唯一性，否则路由结果不确定

BEGIN;

-- 添加唯一约束（幂等：约束已存在时跳过）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'virtual_mcps'
      AND constraint_name = 'virtual_mcps_name_unique'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE virtual_mcps
      ADD CONSTRAINT virtual_mcps_name_unique UNIQUE (name);
  END IF;
END $$;

COMMIT;

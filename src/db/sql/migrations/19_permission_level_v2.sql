-- Linguist LLM Gateway — 19: Permission Level V2
-- 将权限级别从 3 级 (none/view/edit) 简化为 2 级 (view/edit)
-- 所有现有 'none' 值升级为 'view'（所有登录用户默认拥有查看权限）

BEGIN;

UPDATE users
SET permissions = (
  SELECT jsonb_object_agg(
    key,
    CASE WHEN value = '"none"' THEN '"view"' ELSE value END
  )
  FROM jsonb_each(permissions)
)
WHERE permissions IS NOT NULL
  AND permissions ?| ARRAY['models', 'mcp', 'apps', 'users', 'settings']
  AND (
    permissions->>'models' = 'none' OR
    permissions->>'mcp' = 'none' OR
    permissions->>'apps' = 'none' OR
    permissions->>'users' = 'none' OR
    permissions->>'settings' = 'none'
  );

COMMIT;

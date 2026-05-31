-- Linguist LLM Gateway — 11: User Permissions
-- 为用户表新增细粒度权限控制字段
-- 支持 5 个模块：models, mcp, apps, users, settings
-- 每个模块权限级别：none, view, edit

BEGIN;

-- ==================== 1. 权限字段 ====================
-- 现有用户默认全部 edit 权限（向后兼容）
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL
  DEFAULT '{"models":"edit","mcp":"edit","apps":"edit","users":"edit","settings":"edit"}'::jsonb;

-- ==================== 2. OIDC 预留 ====================
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub VARCHAR(255) UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ==================== 3. 索引 ====================
-- 用于 OIDC 登录时按 sub 查找用户
CREATE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;

COMMIT;

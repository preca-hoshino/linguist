-- Linguist LLM Gateway — 01: 用户系统与鉴权核心
-- 涵盖系统登录用户与对外的 API Key 凭证体系

BEGIN;

-- ==================== 用户表 ====================
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(8)   PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    email         VARCHAR(200) UNIQUE NOT NULL,
    password_hash TEXT         NOT NULL,
    avatar_data   TEXT         DEFAULT '',       -- Base64 encoded avatar image (data:image/...;base64,...)
    is_active     BOOLEAN      DEFAULT true,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== API Key 表 ====================
CREATE TABLE IF NOT EXISTS api_keys (
    id          VARCHAR(8)   PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,           -- 描述性名称（如 "Production App"）
    key_hash    TEXT         NOT NULL UNIQUE,    -- SHA-256 哈希存储
    key_prefix  VARCHAR(20)  NOT NULL,           -- 前缀用于列表展示和识别（如 "lk-a3b4c5d6"）
    is_active   BOOLEAN      DEFAULT true,
    expires_at  TIMESTAMPTZ,                     -- 可选过期时间
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

CREATE INDEX IF NOT EXISTS idx_ak_hash    ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ak_active  ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_ak_prefix  ON api_keys(key_prefix);

COMMIT;

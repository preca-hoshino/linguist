-- 路由策略精简：移除 simple，仅保留 load_balance 和 failover
-- load_balance: 加权随机选一个后端，失败即返回错误（不重试）
-- failover: 按 priority 排序取第一个激活后端，失败即返回错误（不重试）
-- 幂等：DROP CONSTRAINT IF EXISTS + ALTER TABLE

BEGIN;

-- 将已有的 simple 记录统一迁移到 load_balance（避免 CHECK 冲突）
UPDATE virtual_models
SET routing_strategy = 'load_balance'
WHERE routing_strategy = 'simple';

-- 替换 CHECK 约束：仅保留两种合法策略
ALTER TABLE virtual_models
    DROP CONSTRAINT IF EXISTS virtual_models_routing_strategy_check;

ALTER TABLE virtual_models
    ADD CONSTRAINT virtual_models_routing_strategy_check
    CHECK (routing_strategy IN ('load_balance', 'failover'));

COMMIT;

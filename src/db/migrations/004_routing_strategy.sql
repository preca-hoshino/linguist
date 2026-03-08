-- 路由策略精简：移除 round_robin 和已变名的 simple，统一三种策略
-- simple: 直连单点，失败即返回清晰错误（不重试）
-- load_balance: 加权随机选一个后端，失败即返回清晰错误（不重试）
-- failover: 按 priority 依次尝试所有后端，全部失败才报错
-- 幂等：DROP CONSTRAINT IF EXISTS + ALTER TABLE

BEGIN;

-- 将已有的 round_robin 记录统一迁移到 failover（避免 CHECK 冲突）
UPDATE virtual_models
SET routing_strategy = 'failover'
WHERE routing_strategy = 'round_robin';

-- 替换 CHECK 约束：仅保留三种合法策略
ALTER TABLE virtual_models
    DROP CONSTRAINT IF EXISTS virtual_models_routing_strategy_check;

ALTER TABLE virtual_models
    ADD CONSTRAINT virtual_models_routing_strategy_check
    CHECK (routing_strategy IN ('simple', 'load_balance', 'failover'));

COMMIT;

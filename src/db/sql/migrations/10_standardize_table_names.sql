-- Migration 10: 数据库表命名标准化
-- 将 app_allowed_models → app_virtual_models
--     app_allowed_mcps  → app_virtual_mcps
--     request_logs_details（及其分区表）→ request_log_details
BEGIN;

-- 应用白名单表重命名
ALTER TABLE app_allowed_models RENAME TO app_virtual_models;
ALTER TABLE app_allowed_mcps RENAME TO app_virtual_mcps;

-- 请求日志详情主表及分区重命名
ALTER TABLE request_logs_details RENAME TO request_log_details;
ALTER TABLE request_logs_details_2026_01 RENAME TO request_log_details_2026_01;
ALTER TABLE request_logs_details_2026_02 RENAME TO request_log_details_2026_02;
ALTER TABLE request_logs_details_2026_03 RENAME TO request_log_details_2026_03;
ALTER TABLE request_logs_details_2026_04 RENAME TO request_log_details_2026_04;
ALTER TABLE request_logs_details_2026_05 RENAME TO request_log_details_2026_05;
ALTER TABLE request_logs_details_2026_06 RENAME TO request_log_details_2026_06;
ALTER TABLE request_logs_details_2026_h2 RENAME TO request_log_details_2026_h2;
ALTER TABLE request_logs_details_default RENAME TO request_log_details_default;

COMMIT;

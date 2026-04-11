-- 09_remove_app_icon.sql
-- Description: Removed custom icon support from applications

ALTER TABLE apps DROP COLUMN IF EXISTS icon;

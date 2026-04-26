#!/usr/bin/env ts-node
/**
 * migrate-mcp-logs.ts
 * 一次性开发数据迁移脚本：将旧版 mcp_logs（单表混存）备份为 JSON，
 * 并将数据映射至新版冷热双表结构（mcp_logs + mcp_log_details）。
 *
 * 执行顺序：
 *   1. 先运行本脚本（备份 + 迁移旧数据）
 *   2. 再运行 npm run db:migrate（应用 migration 11，DROP 旧表，建新表）
 *
 * ⚠️  开发环境替代方案：若不需要保留旧数据，直接运行 npm run db:reset 即可
 *
 * 运行方式（在 Linguist 项目根目录）：
 *   npx ts-node --project tsconfig.json scripts/migrate-mcp-logs.ts
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/** 旧版 mcp_logs 行结构（单表混存） */
interface OldMcpLogRow {
  id: string;
  virtual_mcp_id: string | null;
  mcp_provider_id: string | null;
  app_id: string | null;
  session_id: string;
  method: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  duration_ms: number;
  created_at: string;
}

const BATCH_SIZE = 200;

async function main(): Promise<void> {
  console.log('[MigrateML] Starting mcp_logs migration...');

  // ── Step 1：检查旧表是否存在 ──────────────────────────────────────────
  const tableCheck = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'mcp_logs'
    ) AS exists
  `);

  if (!tableCheck.rows[0]?.exists) {
    console.log('[MigrateML] Table mcp_logs does not exist. Nothing to migrate.');
    await pool.end();
    return;
  }

  // ── Step 2：读取全表旧数据 ────────────────────────────────────────────
  console.log('[MigrateML] Reading existing mcp_logs data...');
  const { rows: oldRows } = await pool.query<OldMcpLogRow>(`
    SELECT id, virtual_mcp_id, mcp_provider_id, app_id, session_id,
           method, params, result, error, duration_ms, created_at
    FROM mcp_logs
    ORDER BY created_at ASC
  `);

  console.log(`[MigrateML] Found ${oldRows.length} rows to migrate.`);

  if (oldRows.length === 0) {
    console.log('[MigrateML] No data to migrate. Migration complete.');
    await pool.end();
    return;
  }

  // ── Step 3：导出 JSON 备份 ────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFileName = `mcp_logs_backup_${timestamp}.json`;
  const backupPath = path.join(process.cwd(), backupFileName);
  fs.writeFileSync(backupPath, JSON.stringify(oldRows, null, 2), 'utf8');
  console.log(`[MigrateML] Backup saved to: ${backupPath}`);

  // ── Step 4：检查新表是否已存在（需要在 migration 11 之后才存在） ──────
  const newTableCheck = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mcp_logs'
        AND column_name = 'status'
    ) AS exists
  `);

  if (!newTableCheck.rows[0]?.exists) {
    console.log('[MigrateML] New mcp_logs schema (with status column) not detected.');
    console.log('[MigrateML] Please run "npm run db:migrate" first to apply migration 11, then re-run this script to import data.');
    console.log(`[MigrateML] Backup is saved at: ${backupPath}`);
    await pool.end();
    return;
  }

  // ── Step 5：将旧数据映射写入新双表结构 ──────────────────────────────
  console.log('[MigrateML] Writing data to new mcp_logs + mcp_log_details tables...');

  let migrated = 0;
  let skipped = 0;

  for (let i = 0; i < oldRows.length; i += BATCH_SIZE) {
    const batch = oldRows.slice(i, i + BATCH_SIZE);

    for (const row of batch) {
      // 从 params 提取工具名（tools/call 时 params.name 存储工具名）
      const toolName: string | null =
        row.method === 'tools/call' && typeof row.params?.['name'] === 'string'
          ? row.params['name']
          : null;

      // 从 error 提取错误摘要
      const errorMessage: string | null =
        row.error !== null && typeof row.error?.['message'] === 'string'
          ? row.error['message']
          : null;

      // 构建新版 mcp_context（冷数据快照）
      const mcpContext = {
        id: row.id,
        virtualMcpId: row.virtual_mcp_id ?? '',
        virtualMcpName: '', // 旧数据无此字段，留空
        mcpProviderId: row.mcp_provider_id ?? '',
        appId: row.app_id ?? undefined,
        sessionId: row.session_id,
        method: row.method,
        toolName: toolName ?? undefined,
        status: 'completed' as const, // 旧数据无法区分历史成功/失败，统一标记为 completed
        audit: {
          params: row.params,
          result: row.result,
          error: row.error ?? undefined,
        },
        errorMessage: errorMessage ?? undefined,
        timing: {
          start: new Date(row.created_at).getTime(),
          end: new Date(row.created_at).getTime() + row.duration_ms,
        },
      };

      try {
        // 写入窄表 mcp_logs（使用旧数据的 created_at 保持时间连续性）
        await pool.query(
          `INSERT INTO mcp_logs
             (id, virtual_mcp_id, mcp_provider_id, app_id, session_id, status,
              method, tool_name, error_message, duration_ms, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT DO NOTHING`,
          [
            row.id,
            row.virtual_mcp_id,
            row.mcp_provider_id,
            row.app_id,
            row.session_id,
            'completed',
            row.method,
            toolName,
            errorMessage,
            row.duration_ms,
            row.created_at,
          ],
        );

        // 写入冷表 mcp_log_details
        await pool.query(
          `INSERT INTO mcp_log_details (id, mcp_context, created_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT DO NOTHING`,
          [row.id, JSON.stringify(mcpContext), row.created_at],
        );

        migrated++;
      } catch (err) {
        console.warn(`[MigrateML] Skipped row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
      }
    }

    console.log(`[MigrateML] Progress: ${Math.min(i + BATCH_SIZE, oldRows.length)} / ${oldRows.length}`);
  }

  // ── Step 6：输出汇总 ─────────────────────────────────────────────────
  console.log('');
  console.log('[MigrateML] ✅ Migration complete.');
  console.log(`[MigrateML]   Migrated : ${migrated}`);
  console.log(`[MigrateML]   Skipped  : ${skipped}`);
  console.log(`[MigrateML]   Backup   : ${backupPath}`);

  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[MigrateML] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

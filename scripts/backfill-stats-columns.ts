#!/usr/bin/env ts-node
/**
 * backfill-stats-columns.ts
 * 存量数据回填脚本：从 request_log_details.gateway_context 中提取统计字段，
 * 批量回填至 request_logs 窄表的新增列（duration_ms / ttft_ms / provider_duration_ms / user_format）。
 *
 * 执行完毕后请删除本脚本。
 * 运行方式（在 Linguist 项目根目录）：
 *   npx ts-node --project tsconfig.json scripts/backfill-stats-columns.ts
 */

import { Pool } from 'pg';

// 直接读环境变量（与 src/db/client.ts 保持一致）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const BATCH_SIZE = 500;

async function main() {
  console.log('[Backfill] Starting stats columns backfill...');

  let offset = 0;
  let totalUpdated = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 查询尚未回填的日志（至少一个新列为 NULL 且有对应的 detail 行）
    const { rows } = await pool.query<{
      id: string;
      gateway_context: Record<string, unknown> | null;
    }>(
      `SELECT r.id, d.gateway_context
       FROM request_logs r
       JOIN request_log_details d ON r.id = d.id
       WHERE (r.duration_ms IS NULL OR r.ttft_ms IS NULL OR r.provider_duration_ms IS NULL OR r.user_format IS NULL)
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );

    if (rows.length === 0) {
      break;
    }

    let batchUpdated = 0;

    for (const row of rows) {
      const ctx = row.gateway_context;
      if (!ctx) continue;

      // 提取 timing
      const timing = ctx.timing as Record<string, unknown> | undefined;
      const durationMs =
        typeof timing?.total_duration_ms === 'number' ? Math.round(timing.total_duration_ms) : null;
      const ttftMs =
        typeof timing?.ttft_ms === 'number' ? Math.round(timing.ttft_ms) : null;
      const providerDurationMs =
        typeof timing?.provider_duration_ms === 'number' ? Math.round(timing.provider_duration_ms) : null;

      // 提取 user_format
      const userFormat =
        typeof ctx.user_format === 'string' && ctx.user_format !== '' ? ctx.user_format : null;

      // 只要有变更就更新
      if (durationMs !== null || ttftMs !== null || providerDurationMs !== null || userFormat !== null) {
        await pool.query(
          `UPDATE request_logs
           SET duration_ms         = COALESCE(duration_ms, $1),
               ttft_ms             = COALESCE(ttft_ms, $2),
               provider_duration_ms = COALESCE(provider_duration_ms, $3),
               user_format         = COALESCE(user_format, $4)
           WHERE id = $5`,
          [durationMs, ttftMs, providerDurationMs, userFormat, row.id],
        );
        batchUpdated++;
      }
    }

    totalUpdated += batchUpdated;
    offset += rows.length;
    console.log(`[Backfill] Processed ${offset} rows, updated ${totalUpdated} so far...`);
  }

  console.log(`[Backfill] Done. Total rows updated: ${totalUpdated}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exitCode = 1;
});

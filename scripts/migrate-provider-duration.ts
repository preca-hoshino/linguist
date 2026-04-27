/**
 * scripts/migrate-provider-duration.ts
 *
 * 一次性历史数据回填脚本（运行完即删除）
 *
 * 目标：将 request_log_details.timing JSONB 中的
 * providerEnd - providerStart 计算结果回填到
 * request_logs.provider_duration_ms 热表列。
 *
 * 用法：
 *   npx tsx scripts/migrate-provider-duration.ts
 *
 * 特性：
 * - 分批处理（BATCH_SIZE 行/批），避免长事务锁表
 * - 跳过已有值（provider_duration_ms IS NOT NULL）
 * - 每批打印进度，支持随时中断重跑（幂等）
 */

import * as dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const BATCH_SIZE = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // 先查总数（仅需回填的行）
    const countRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt
      FROM request_logs r
      JOIN request_log_details d ON d.id = r.id
      WHERE r.provider_duration_ms IS NULL
        AND d.timing->>'providerEnd' IS NOT NULL
        AND d.timing->>'providerStart' IS NOT NULL
    `);
    const total = Number(countRes.rows[0]?.cnt ?? 0);
    console.log(`[migrate] 需要回填的记录数：${total}`);

    if (total === 0) {
      console.log('[migrate] 无需回填，退出。');
      return;
    }

    let updated = 0;
    let batchNum = 0;

    while (true) {
      batchNum++;
      const res = await client.query<{ updated_count: string }>(`
        WITH batch AS (
          SELECT r.id, r.created_at
          FROM request_logs r
          JOIN request_log_details d ON d.id = r.id
          WHERE r.provider_duration_ms IS NULL
            AND d.timing->>'providerEnd' IS NOT NULL
            AND d.timing->>'providerStart' IS NOT NULL
          LIMIT ${BATCH_SIZE}
        ),
        upd AS (
          UPDATE request_logs r
          SET provider_duration_ms = (
            (d.timing->>'providerEnd')::float - (d.timing->>'providerStart')::float
          )::integer
          FROM batch b
          JOIN request_log_details d ON d.id = b.id
          WHERE r.id = b.id AND r.created_at = b.created_at
          RETURNING r.id
        )
        SELECT COUNT(*)::text AS updated_count FROM upd
      `);

      const batchUpdated = Number(res.rows[0]?.updated_count ?? 0);
      updated += batchUpdated;

      const pct = total > 0 ? ((updated / total) * 100).toFixed(1) : '100.0';
      console.log(`[migrate] 批次 #${batchNum} 完成：+${batchUpdated} 行，累计 ${updated}/${total} (${pct}%)`);

      if (batchUpdated === 0) {
        break;
      }
    }

    console.log(`[migrate] 回填完成，共更新 ${updated} 行。`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err: unknown) => {
  console.error('[migrate] 脚本异常：', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

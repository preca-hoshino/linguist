#!/usr/bin/env tsx
/**
 * scripts/backfill-reasoning-billing.ts
 *
 * 存量计费修复脚本
 *
 * 背景：
 *   在修复 reasoning_tokens 计费漏计问题之前，所有使用推理模型（DeepSeek R1、
 *   Volcengine 深度思考、Gemini Thinking）的历史请求 calculated_cost 均未包含
 *   思维链 token 的费用，导致成本统计偏低。
 *
 * 本脚本功能：
 *   1. 扫描所有 status = 'completed' 且 reasoning_tokens > 0 的请求日志
 *   2. 从 gateway_context 提取完整 usage 数据（含 reasoning_tokens）
 *   3. 查询对应模型的阶梯定价配置
 *   4. 用修复后的计费逻辑（reasoning 并入 output_price）重新计算 calculated_cost
 *   5. 批量 UPDATE request_logs.calculated_cost
 *
 * 用法：
 *   npx tsx scripts/backfill-reasoning-billing.ts
 *   npx tsx scripts/backfill-reasoning-billing.ts --dry-run   # 仅打印，不写入
 *   npx tsx scripts/backfill-reasoning-billing.ts --batch-size 200
 *
 * 注意：
 *   - 脚本幂等，可重复执行
 *   - 通过 DATABASE_URL 环境变量连接数据库（与主服务相同）
 *   - 如需指定时间范围，可修改下方 DATE_RANGE 常量
 */

import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';

// ---- 加载 .env（开发环境使用，生产环境由容器注入）----
loadDotenv();

// ==================== 配置 ====================

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = (() => {
  const idx = process.argv.indexOf('--batch-size');
  return idx !== -1 && process.argv[idx + 1] ? Number.parseInt(process.argv[idx + 1]!, 10) : 100;
})();
// 设为 undefined 则不限制时间范围
const DATE_FROM: string | undefined = undefined;
const DATE_TO: string | undefined = undefined;

// ==================== 类型定义 ====================

interface PricingTier {
  start_tokens: number;
  input_price: number;
  output_price: number;
  cache_price: number;
}

interface UsageFromCtx {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
}

interface LogRow {
  id: string;
  provider_id: string;
  routed_model: string;
  calculated_cost: string; // numeric → string
  usage: UsageFromCtx | null;
}

// ==================== 计费逻辑（与 calculator.ts 保持一致）====================

function toFixed6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function recalculateCost(
  tiers: readonly PricingTier[],
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  reasoningTokens: number,
): number | null {
  if (tiers.length === 0) return null;
  if (promptTokens <= 0 && completionTokens <= 0) return null;

  const sorted = [...tiers].sort((a, b) => b.start_tokens - a.start_tokens);
  const matchedTier = sorted.find((t) => promptTokens >= t.start_tokens);
  const tier = matchedTier ?? sorted.at(-1);
  if (!tier) return null;

  const UNIT = 1_000_000;
  const safeCached = Math.max(0, Math.min(cachedTokens, promptTokens));
  const pureInputTokens = Math.max(0, promptTokens - safeCached);

  const inputCost = (pureInputTokens / UNIT) * tier.input_price;
  const cacheCost = (safeCached / UNIT) * tier.cache_price;
  const totalOutputTokens = completionTokens + Math.max(0, reasoningTokens);
  const outputCost = (totalOutputTokens / UNIT) * tier.output_price;

  return toFixed6(inputCost + cacheCost + outputCost);
}

// ==================== 主流程 ====================

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  console.log(`\n🔧 存量计费修复脚本`);
  console.log(`   模式: ${DRY_RUN ? '🔍 DRY RUN（只读，不写入）' : '✏️  实际写入'}`);
  console.log(`   批量大小: ${BATCH_SIZE}`);
  if (DATE_FROM ?? DATE_TO) {
    console.log(`   时间范围: ${DATE_FROM ?? '*'} ~ ${DATE_TO ?? '*'}`);
  }
  console.log('');

  // 1. 统计目标记录总数
  const dateConditions: string[] = [];
  const countParams: unknown[] = [];
  let pIdx = 1;
  if (DATE_FROM) {
    dateConditions.push(`r.created_at >= $${pIdx++}`);
    countParams.push(DATE_FROM);
  }
  if (DATE_TO) {
    dateConditions.push(`r.created_at <= $${pIdx++}`);
    countParams.push(DATE_TO);
  }
  const dateWhere = dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ')}` : '';

  // 只处理有 reasoning_tokens 的记录（其余记录计费结果不受影响）
  const countSql = `
    SELECT COUNT(*) AS total
    FROM request_logs r
    LEFT JOIN request_logs_details d ON d.id = r.id
    WHERE r.status = 'completed'
      AND r.provider_id IS NOT NULL
      AND r.routed_model IS NOT NULL
      AND (d.gateway_context->'response'->'usage'->>'reasoning_tokens')::bigint > 0
      ${dateWhere}
  `;
  const countRes = await pool.query<{ total: string }>(countSql, countParams);
  const total = Number.parseInt(countRes.rows[0]?.total ?? '0', 10);

  if (total === 0) {
    console.log('✅ 没有需要修复的记录（reasoning_tokens > 0 的已完成请求为零）。');
    await pool.end();
    return;
  }

  console.log(`📊 需要修复的记录: ${total} 条`);
  console.log('');

  // 2. 预加载定价配置（避免每条记录单独查询）
  const tiersMap = new Map<string, readonly PricingTier[]>(); // key: `${providerId}::${modelName}`

  async function getTiers(providerId: string, modelName: string): Promise<readonly PricingTier[]> {
    const key = `${providerId}::${modelName}`;
    if (tiersMap.has(key)) return tiersMap.get(key)!;
    const res = await pool.query<{ pricing_tiers: PricingTier[] }>(
      'SELECT pricing_tiers FROM model_provider_models WHERE provider_id = $1 AND name = $2 LIMIT 1',
      [providerId, modelName],
    );
    const tiers = res.rows[0]?.pricing_tiers ?? [];
    tiersMap.set(key, tiers);
    return tiers;
  }

  // 3. 分批处理
  let offset = 0;
  let processed = 0;
  let updated = 0;
  let skipped = 0;

  const batchSql = `
    SELECT
      r.id,
      r.provider_id,
      r.routed_model,
      r.calculated_cost::text,
      (d.gateway_context->'response'->'usage') AS usage
    FROM request_logs r
    LEFT JOIN request_logs_details d ON d.id = r.id
    WHERE r.status = 'completed'
      AND r.provider_id IS NOT NULL
      AND r.routed_model IS NOT NULL
      AND (d.gateway_context->'response'->'usage'->>'reasoning_tokens')::bigint > 0
      ${dateWhere}
    ORDER BY r.created_at ASC
    LIMIT $${pIdx} OFFSET $${pIdx + 1}
  `;

  while (offset < total) {
    const batchParams = [...countParams, BATCH_SIZE, offset];
    const rows = await pool.query<LogRow>(batchSql, batchParams);

    if (rows.rows.length === 0) break;

    // 收集本批次的 UPDATE 数据
    const updates: Array<{ id: string; newCost: number; oldCost: number }> = [];

    for (const row of rows.rows) {
      const usage = row.usage as UsageFromCtx | null;
      if (!usage) {
        skipped++;
        continue;
      }

      const promptTokens = Number(usage.prompt_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? 0);
      const cachedTokens = Number(usage.cached_tokens ?? 0);
      const reasoningTokens = Number(usage.reasoning_tokens ?? 0);

      if (reasoningTokens <= 0) {
        skipped++;
        continue;
      }

      const tiers = await getTiers(row.provider_id, row.routed_model);
      if (tiers.length === 0) {
        skipped++;
        continue;
      }

      const newCost = recalculateCost(tiers, promptTokens, completionTokens, cachedTokens, reasoningTokens);
      if (newCost === null) {
        skipped++;
        continue;
      }

      const oldCost = Number(row.calculated_cost ?? 0);

      // 仅在费用实际变化时更新（避免浮点噪声导致无意义写入）
      if (Math.abs(newCost - oldCost) < 1e-9) {
        skipped++;
        continue;
      }

      updates.push({ id: row.id, newCost, oldCost });
    }

    processed += rows.rows.length;

    if (updates.length > 0 && !DRY_RUN) {
      // 批量 UPDATE（使用 unnest 一次提交）
      const ids = updates.map((u) => u.id);
      const costs = updates.map((u) => u.newCost);

      await pool.query(
        `UPDATE request_logs
         SET calculated_cost = v.cost
         FROM (
           SELECT unnest($1::uuid[]) AS id, unnest($2::numeric[]) AS cost
         ) AS v
         WHERE request_logs.id = v.id`,
        [ids, costs],
      );
    }

    if (DRY_RUN && updates.length > 0) {
      for (const u of updates) {
        console.log(`  [DRY] ${u.id}: ${u.oldCost.toFixed(6)} → ${u.newCost.toFixed(6)}`);
      }
    }

    updated += updates.length;
    const percent = Math.min(100, Math.round((processed / total) * 100));
    process.stdout.write(
      `\r   进度: ${processed}/${total} (${percent}%) | 已更新: ${updated} | 已跳过: ${skipped}   `,
    );

    offset += BATCH_SIZE;
  }

  console.log('\n');
  console.log(`✅ 修复完成`);
  console.log(`   总扫描: ${processed} 条`);
  console.log(`   已更新: ${updated} 条`);
  console.log(`   已跳过: ${skipped} 条（无定价/费用无变化/无reasoning）`);
  if (DRY_RUN) {
    console.log('\n⚠️  当前为 DRY RUN 模式，以上更新均未实际写入。移除 --dry-run 参数后重新运行以提交变更。');
  }

  await pool.end();
}

main().catch((err: unknown) => {
  console.error('❌ 脚本执行失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

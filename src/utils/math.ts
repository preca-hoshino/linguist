// src/utils/math.ts — 通用数值计算工具

/**
 * 四舍五入到 2 位小数
 */
export function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 安全比率计算（避免除零），保留 4 位小数
 */
export function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

/**
 * 四舍五入 number | null
 */
export function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

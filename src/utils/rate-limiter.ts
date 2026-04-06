// src/utils/rate-limiter.ts — 纯内存 RPM/TPM 限流引擎
//
// 基于固定时间窗口（每分钟一个桶）的高速计数器。
// 每 60 秒自动清空所有桶，无需精确 TTL 管理。
// 单节点部署场景下替代 Redis，零外部依赖。

import { createLogger, logColors } from './logger';

const logger = createLogger('RateLimiter', logColors.bold + logColors.magenta);

/** 限流维度标识前缀 @public */
export type RateLimitScope = 'pm' | 'vm';

/**
 * 构建限流器 key
 * @param scope  维度前缀（pm = provider_model, vm = virtual_model）
 * @param metric 指标类型（rpm / tpm）
 * @param id     实体 ID
 */
function buildKey(scope: RateLimitScope, metric: 'rpm' | 'tpm', id: string): string {
  return `${scope}:${metric}:${id}`;
}

/**
 * 纯内存限流器
 *
 * 采用固定时间窗口算法，每分钟重置所有计数器。
 * 提供两类操作：
 * - 查询：isLimitReached — 仅检测是否已满，不消耗额度（路由过滤阶段使用）
 * - 扣减：increment* — 实际消耗计数（中间件放行后使用）
 */
/** @public */
export class MemoryRateLimiterImpl {
  /** RPM 计数器 (key → 当前分钟已消耗请求数) */
  private readonly rpmCounters = new Map<string, number>();

  /** TPM 计数器 (key → 当前分钟已消耗 Token 数) */
  private readonly tpmCounters = new Map<string, number>();

  /** 窗口清空定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 启动限流器的后台清理任务
   * 每 60 秒清空所有计数器（固定窗口重置）
   */
  public start(): void {
    if (this.cleanupTimer !== null) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      const rpmSize = this.rpmCounters.size;
      const tpmSize = this.tpmCounters.size;
      this.rpmCounters.clear();
      this.tpmCounters.clear();
      if (rpmSize > 0 || tpmSize > 0) {
        logger.debug({ rpmKeys: rpmSize, tpmKeys: tpmSize }, 'Rate limit counters reset (1-minute window)');
      }
    }, 60_000);

    // 防止定时器阻止进程退出
    this.cleanupTimer.unref();
    logger.info('Memory rate limiter started (60s fixed window)');
  }

  /**
   * 停止限流器
   */
  public stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.rpmCounters.clear();
    this.tpmCounters.clear();
    logger.info('Memory rate limiter stopped');
  }

  // ==================== 查询（不消耗额度） ====================

  /**
   * 检查 RPM 是否已达到上限
   * @param scope 维度
   * @param id    实体 ID
   * @param limit 上限值（undefined 表示不限制）
   * @returns true = 已满载，false = 有余量或无限制
   */
  public isRpmFull(scope: RateLimitScope, id: string, limit: number | undefined): boolean {
    if (limit === undefined) {
      return false;
    }
    const key = buildKey(scope, 'rpm', id);
    const current = this.rpmCounters.get(key) ?? 0;
    return current >= limit;
  }

  /**
   * 检查 TPM 是否已达到上限
   * @param scope 维度
   * @param id    实体 ID
   * @param limit 上限值（undefined 表示不限制）
   * @returns true = 已满载，false = 有余量或无限制
   */
  public isTpmFull(scope: RateLimitScope, id: string, limit: number | undefined): boolean {
    if (limit === undefined) {
      return false;
    }
    const key = buildKey(scope, 'tpm', id);
    const current = this.tpmCounters.get(key) ?? 0;
    return current >= limit;
  }

  // ==================== 扣减（消耗额度） ====================

  /**
   * 增加 RPM 计数（+1）
   * @returns 增加后的累计值
   */
  public incrementRpm(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'rpm', id);
    const next = (this.rpmCounters.get(key) ?? 0) + 1;
    this.rpmCounters.set(key, next);
    return next;
  }

  /**
   * 增加 TPM 计数
   * @param amount 本次消耗的 Token 数
   * @returns 增加后的累计值
   */
  public incrementTpm(scope: RateLimitScope, id: string, amount: number): number {
    const key = buildKey(scope, 'tpm', id);
    const next = (this.tpmCounters.get(key) ?? 0) + amount;
    this.tpmCounters.set(key, next);
    return next;
  }

  // ==================== 诊断（管理 API / 调试） ====================

  /**
   * 获取当前窗口的 RPM 使用量
   */
  public getRpmUsage(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'rpm', id);
    return this.rpmCounters.get(key) ?? 0;
  }

  /**
   * 获取当前窗口的 TPM 使用量
   */
  public getTpmUsage(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'tpm', id);
    return this.tpmCounters.get(key) ?? 0;
  }
}

/** 全局单例 */
export const rateLimiter: MemoryRateLimiterImpl = new MemoryRateLimiterImpl();

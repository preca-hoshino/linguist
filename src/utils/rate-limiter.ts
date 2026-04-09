// src/utils/rate-limiter.ts — 纯内存 RPM/TPM 限流引擎
//
// 基于滑动时间窗口（60 秒）的高速计数器，提供平滑流控效果。
// 后台定时清理过期计数器（免除 Redis 依赖）。
// 单节点部署场景下的最佳实践。

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
 * 滑动窗口计数器 (60 秒)
 * - 划分为 60 个 1 秒的桶
 * - 通过 Float64Array 存储数据，满足大数值 TPM (最大 9 万亿 Token/秒，无需担忧溢出)
 */
class SlidingWindowCounter {
  private readonly buckets = new Float64Array(60);
  private lastSecond: number;

  public constructor() {
    this.lastSecond = Math.floor(Date.now() / 1000);
  }

  public add(amount: number): number {
    this.advance();
    const curr = Math.floor(Date.now() / 1000) % 60;
    this.buckets[curr] = (this.buckets[curr] ?? 0) + amount;
    return this.getSum();
  }

  public get(): number {
    this.advance();
    return this.getSum();
  }

  private advance(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = nowSec - this.lastSecond;
    if (diff > 0) {
      if (diff >= 60) {
        this.buckets.fill(0);
      } else {
        for (let i = 1; i <= diff; i++) {
          this.buckets[(this.lastSecond + i) % 60] = 0;
        }
      }
      this.lastSecond = nowSec;
    }
  }

  private getSum(): number {
    let sum = 0;
    for (let i = 0; i < 60; i++) {
      sum += this.buckets[i] ?? 0;
    }
    return sum;
  }

  public isStale(nowSec: number): boolean {
    return nowSec - this.lastSecond >= 60;
  }
}

/**
 * 纯内存限流器
 *
 * 采用滑动窗口算法，精确统计过往 60 秒的请求与 Token 消耗。
 * 提供两类操作：
 * - 查询：isLimitReached — 仅检测是否已满，不消耗额度（路由过滤阶段使用）
 * - 扣减：increment* — 实际消耗计数（中间件放行后使用）
 */
/** @public */
export class MemoryRateLimiterImpl {
  /** RPM 计数器 */
  private readonly rpmCounters = new Map<string, SlidingWindowCounter>();

  /** TPM 计数器 */
  private readonly tpmCounters = new Map<string, SlidingWindowCounter>();

  /** 定时清理无活动计数器的定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 启动限流器的后台清理任务
   * 每 5 分钟清理长达 60 秒未活动的过期计数器，防止内存泄漏。
   */
  public start(): void {
    if (this.cleanupTimer !== null) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      const nowSec = Math.floor(Date.now() / 1000);
      let removed = 0;

      for (const [key, counter] of this.rpmCounters.entries()) {
        if (counter.isStale(nowSec)) {
          this.rpmCounters.delete(key);
          removed++;
        }
      }
      for (const [key, counter] of this.tpmCounters.entries()) {
        if (counter.isStale(nowSec)) {
          this.tpmCounters.delete(key);
          removed++;
        }
      }

      if (removed > 0) {
        logger.debug({ gcRemoved: removed }, 'Rate limit counters GC completed');
      }
    }, 5 * 60_000);

    // 防止定时器阻止进程退出
    this.cleanupTimer.unref();
    logger.info('Memory rate limiter started (60s sliding window)');
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
    const counter = this.rpmCounters.get(key);
    const current = counter ? counter.get() : 0;
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
    const counter = this.tpmCounters.get(key);
    const current = counter ? counter.get() : 0;
    return current >= limit;
  }

  // ==================== 扣减（消耗额度） ====================

  /**
   * 增加 RPM 计数（+1）
   * @returns 增加后的累计值
   */
  public incrementRpm(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'rpm', id);
    let counter = this.rpmCounters.get(key);
    if (!counter) {
      counter = new SlidingWindowCounter();
      this.rpmCounters.set(key, counter);
    }
    return counter.add(1);
  }

  /**
   * 增加 TPM 计数
   * @param amount 本次消耗的 Token 数
   * @returns 增加后的累计值
   */
  public incrementTpm(scope: RateLimitScope, id: string, amount: number): number {
    const key = buildKey(scope, 'tpm', id);
    let counter = this.tpmCounters.get(key);
    if (!counter) {
      counter = new SlidingWindowCounter();
      this.tpmCounters.set(key, counter);
    }
    return counter.add(amount);
  }

  // ==================== 诊断（管理 API / 调试） ====================

  /**
   * 获取当前窗口（近 60 秒）的 RPM 使用量
   */
  public getRpmUsage(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'rpm', id);
    const counter = this.rpmCounters.get(key);
    return counter ? counter.get() : 0;
  }

  /**
   * 获取当前窗口（近 60 秒）的 TPM 使用量
   */
  public getTpmUsage(scope: RateLimitScope, id: string): number {
    const key = buildKey(scope, 'tpm', id);
    const counter = this.tpmCounters.get(key);
    return counter ? counter.get() : 0;
  }
}

/** 全局单例 */
export const rateLimiter: MemoryRateLimiterImpl = new MemoryRateLimiterImpl();

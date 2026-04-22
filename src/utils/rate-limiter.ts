// src/utils/rate-limiter.ts — 纯内存 RPM/TPM 限流引擎
//
// 基于滑动时间窗口（60 秒）的高速计数器，提供平滑流控效果。
// 后台定时清理过期计数器（免除 Redis 依赖）。
// 单节点部署场景下的最佳实践。

import { createLogger, logColors } from './logger';

const logger = createLogger('RateLimiter', logColors.bold + logColors.magenta);

/** 限流维度标识前缀 @public */
export type RateLimitScope = 'pm' | 'vm' | 'p';

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
 * 主流 O(1) 滑动窗口计数器（基于 Cloudflare / Redis 实践）
 *
 * 核心逻辑：
 * 维持当前窗口（一分钟）和上一个窗口的计数。
 * 当前总使用量 = 上个窗口计数 * (1 - 当前窗口已过时间比例) + 当前窗口计数
 *
 * 优势体现在：
 * 1. 内存极低：每个限流 Key 仅需 3 个数字记录状态 (数十字节 vs. 数组方案的数百字节)。
 * 2. 算力开销 O(1)：查询时不需遍历 60 个数组桶循环累加。
 * 3. 抹平毛刺：假定流量在窗口期内均匀分布，能极其平滑地实现降级过渡。
 */
class SlidingWindowCounter {
  private prevCount = 0;
  private currCount = 0;
  private currWindowStart: number;
  private readonly windowSizeMs = 60_000; // 60秒固定窗口大小

  public constructor() {
    this.currWindowStart = this.getCurrentWindowStart();
  }

  private getCurrentWindowStart(): number {
    return Math.floor(Date.now() / this.windowSizeMs) * this.windowSizeMs;
  }

  private advance(): void {
    const nowStart = this.getCurrentWindowStart();
    if (nowStart > this.currWindowStart) {
      // 刚好滑动到下一个相邻窗口，保留当前数据到 prev
      // 若滑动跨越了多个窗口（证明长期间隔），则 prev 归零
      if (nowStart - this.currWindowStart === this.windowSizeMs) {
        this.prevCount = this.currCount;
      } else {
        this.prevCount = 0;
      }
      this.currCount = 0;
      this.currWindowStart = nowStart;
    }
  }

  public add(amount: number): number {
    this.advance();
    this.currCount += amount;
    return this.get();
  }

  public get(): number {
    this.advance();
    const now = Date.now();
    const progress = (now - this.currWindowStart) / this.windowSizeMs;
    // 权重：上个窗口在剩余滑动区间内所占的比例
    const weight = Math.max(0, 1 - progress);
    return Math.round(this.prevCount * weight + this.currCount);
  }

  public isStale(nowSec: number): boolean {
    // 若距当前窗口起点超过 2 分钟未更新，该对象则属于静默并可安全回收
    return nowSec * 1000 - this.currWindowStart >= this.windowSizeMs * 2;
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

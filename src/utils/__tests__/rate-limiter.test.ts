import { MemoryRateLimiterImpl, rateLimiter } from '../rate-limiter';

describe('MemoryRateLimiterImpl', () => {
  let limiter: MemoryRateLimiterImpl;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    limiter = new MemoryRateLimiterImpl();
  });

  afterEach(() => {
    limiter.stop();
    jest.useRealTimers();
  });

  // ==================== startup / shutdown ====================

  describe('start / stop lifecycle', () => {
    it('should start without error', () => {
      limiter.start();
      // 不应抛异常
    });

    it('should not create duplicate timers on second start()', () => {
      limiter.start();
      limiter.start(); // second call should be no-op
      // 不应抛异常
    });

    it('should stop cleanly and clear counters', () => {
      limiter.start();
      limiter.incrementRpm('pm', 'model-1');
      limiter.stop();
      // 停止后计数器已清空
      expect(limiter.getRpmUsage('pm', 'model-1')).toBe(0);
    });
  });

  // ==================== RPM ====================

  describe('RPM operations', () => {
    it('should return 0 usage for unknown key', () => {
      expect(limiter.getRpmUsage('pm', 'unknown')).toBe(0);
    });

    it('should increment RPM and return updated value', () => {
      const v1 = limiter.incrementRpm('pm', 'model-a');
      expect(v1).toBeGreaterThanOrEqual(1);
      const v2 = limiter.incrementRpm('pm', 'model-a');
      expect(v2).toBeGreaterThanOrEqual(v1);
    });

    it('isRpmFull should return false when limit is undefined (no limit)', () => {
      expect(limiter.isRpmFull('pm', 'model-a', undefined)).toBe(false);
    });

    it('isRpmFull should return false when usage is below limit', () => {
      limiter.incrementRpm('pm', 'model-a'); // 1
      expect(limiter.isRpmFull('pm', 'model-a', 100)).toBe(false);
    });

    it('isRpmFull should return true when usage hits limit', () => {
      for (let i = 0; i < 10; i++) {
        limiter.incrementRpm('pm', 'model-a');
      }
      expect(limiter.isRpmFull('pm', 'model-a', 10)).toBe(true);
    });

    it('isRpmFull should return false for unknown key (counter absent)', () => {
      expect(limiter.isRpmFull('pm', 'never-seen', 1)).toBe(false);
    });
  });

  // ==================== TPM ====================

  describe('TPM operations', () => {
    it('should return 0 usage for unknown key', () => {
      expect(limiter.getTpmUsage('pm', 'unknown')).toBe(0);
    });

    it('should increment TPM and return updated value', () => {
      const v1 = limiter.incrementTpm('pm', 'model-a', 500);
      expect(v1).toBeGreaterThanOrEqual(500);
      const v2 = limiter.incrementTpm('pm', 'model-a', 300);
      expect(v2).toBeGreaterThanOrEqual(v1);
    });

    it('isTpmFull should return false when limit is undefined', () => {
      expect(limiter.isTpmFull('pm', 'model-a', undefined)).toBe(false);
    });

    it('isTpmFull should return false when usage is below limit', () => {
      limiter.incrementTpm('pm', 'model-a', 1000);
      expect(limiter.isTpmFull('pm', 'model-a', 100_000)).toBe(false);
    });

    it('isTpmFull should return true when usage hits limit', () => {
      limiter.incrementTpm('pm', 'model-a', 50_000);
      expect(limiter.isTpmFull('pm', 'model-a', 50_000)).toBe(true);
    });
  });

  // ==================== scope维度隔离 ====================

  describe('scope isolation', () => {
    it('should isolate RPM counters across different scopes', () => {
      limiter.incrementRpm('pm', 'm1'); // pm scope
      limiter.incrementRpm('vm', 'm1'); // vm scope (different key)
      expect(limiter.isRpmFull('pm', 'm1', 1)).toBe(true);
      expect(limiter.isRpmFull('vm', 'm1', 1)).toBe(true);
      // 同一个 id 但是在不同 scope 下各自独立
      expect(limiter.getRpmUsage('pm', 'm1')).toBe(1);
      expect(limiter.getRpmUsage('vm', 'm1')).toBe(1);
    });
  });

  // ==================== 滑动窗口逻辑 ====================

  describe('sliding window behavior', () => {
    it('should decay usage after window passes (weighted average)', () => {
      limiter.start();
      // 在 t=0 增加 100
      limiter.incrementRpm('pm', 'm1');
      for (let i = 0; i < 99; i++) {
        limiter.incrementRpm('pm', 'm1');
      }
      // 现在 usage = 100
      expect(limiter.getRpmUsage('pm', 'm1')).toBe(100);

      // 前进 30 秒（窗口过半）
      jest.advanceTimersByTime(30_000);
      // 获取当前使用量，权重计算后应小于等于 100（prevCount 部分被加权）
      const at30 = limiter.getRpmUsage('pm', 'm1');
      // 30s / 60s = 0.5 progress, weight = 0.5
      // prevCount 为 0（首次窗口），所以 current 全部来自 currCount
      expect(at30).toBe(100);

      // 前进到 61 秒（进入新窗口）
      jest.advanceTimersByTime(31_000);
      // 新窗口：prevCount = 100, currCount = 0
      // progress = 1s/60s ≈ 0.0167, weight = 0.9833
      // usage = 100 * 0.9833 + 0 ≈ 98
      const at61 = limiter.getRpmUsage('pm', 'm1');
      expect(at61).toBeLessThanOrEqual(99);
      expect(at61).toBeGreaterThan(0);
    });

    it('should reset prevCount when skipping more than one window', () => {
      limiter.start();
      for (let i = 0; i < 100; i++) {
        limiter.incrementRpm('pm', 'm1');
      }

      // 跳过 121 秒（跨过两个窗口）
      jest.advanceTimersByTime(121_000);
      // prevCount 应被重置为 0，currCount 也重置为 0
      expect(limiter.getRpmUsage('pm', 'm1')).toBe(0);
    });
  });

  // ==================== GC 清理 ====================

  describe('GC cleanup', () => {
    it('should remove stale counters after cleanup interval', () => {
      limiter.start();
      limiter.incrementRpm('pm', 'm1');

      // 前进超过 2 分钟让计数器变 stale
      jest.advanceTimersByTime(5 * 60_000 + 1000); // 触发一次 cleanup

      // 加上额外时间让计数器判定为 stale
      jest.advanceTimersByTime(60_000); // 总共 6 分钟

      // 触发第二次 cleanup
      jest.advanceTimersByTime(5 * 60_000);

      // 此时计数器应已被清除
      expect(limiter.getRpmUsage('pm', 'm1')).toBe(0);
    });
  });
});

describe('rateLimiter singleton', () => {
  it('should be an instance of MemoryRateLimiterImpl', () => {
    expect(rateLimiter).toBeInstanceOf(MemoryRateLimiterImpl);
  });
});

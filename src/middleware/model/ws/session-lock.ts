// src/middleware/model/ws/session-lock.ts — 长连接会话互斥锁（占位）

// TODO: Phase 3 实现
// - 基于 sessionId 的内存互斥锁，防止同一会话并发写入
// - 支持超时自动释放（避免死锁）
// - 对接 wsEngine 内部事件总线，在 streaming 状态下加锁
// - 使用 async-mutex 或 Redis 分布式锁（多实例场景）

/**
 * WebSocket 会话互斥锁
 *
 * 确保同一会话在同一时刻只有一个数据帧在处理，
 * 防止并发写入导致的状态不一致（如账单累加错误）。
 */
export async function acquireSessionLock(_sessionId: string): Promise<void> {
  // Phase 3 实现
  await Promise.resolve();
}

/** 释放指定会话的互斥锁 */
export function releaseSessionLock(_sessionId: string): void {
  // Phase 3 实现
}

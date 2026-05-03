// src/middleware/model/ws/billing-accumulator.ts — 实时计费累加中间件（占位）

// TODO: Phase 3 实现
// - 按音频时长（毫秒）累加计费，而非按 Token
// - 文本 Token 按流式 chunk 累积
// - 每次累加后检查额度余量，额度耗尽时发送 usage.exceeded 事件
// - 连接关闭时将累计用量写入数据库 request_logs

/**
 * WebSocket 实时计费累加器
 *
 * 在长连接生命周期内持续累加用量（音频 ms + 文本 token），
 * 支持 byte/ms 粒度计费，并在额度耗尽前发出预警。
 */
export function accumulateBilling(_sessionId: string, _usage: unknown): void {
  // Phase 3 实现
}

/** 获取当前会话的累计计费用量 */
export function getSessionUsage(_sessionId: string): unknown {
  // Phase 3 实现
  return {};
}

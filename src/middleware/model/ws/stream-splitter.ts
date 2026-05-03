// src/middleware/model/ws/stream-splitter.ts — 音频/文本流分片与缓冲中间件（占位）

// TODO: Phase 3 实现
// - 识别 InternalWSFrame 中的音频帧 (input_audio_buffer.append) 和文本帧
// - 将上游 TTS 音频流按固定时长（如 20ms）分片下发
// - 文本流按句子边界拆分（避免截断中文字符）
// - 支持客户端打断（response.cancel），冲刷缓冲区

/**
 * 流分片与缓冲处理器
 *
 * 负责将上游模型返回的混合流（文本 + 音频）按协议要求分片，
 * 确保客户端（如 WebRTC 播放器）能以合适粒度消费数据帧。
 */
export function splitStream(_frameType: string, _payload: unknown): void {
  // Phase 3 实现
}

// src/utils/transform.ts — 轻量数据转换工具

// ==================== JSON 解析 ====================

/**
 * 安全解析 JSON 字符串，失败时包装为 { result: value }
 */
export function safeParseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { result: value };
  }
}

// ==================== MIME 类型推断 ====================

/**
 * 从 MIME 类型推断内部媒体类型
 */
export function mimeToMediaType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  const prefix = mimeType.split('/')[0];
  if (prefix === 'image') {
    return 'image';
  }
  if (prefix === 'audio') {
    return 'audio';
  }
  if (prefix === 'video') {
    return 'video';
  }
  return 'file';
}

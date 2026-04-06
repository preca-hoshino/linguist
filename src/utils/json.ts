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

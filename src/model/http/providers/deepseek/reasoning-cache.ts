// src/model/http/providers/deepseek/reasoning-cache.ts — DeepSeek 推理内容缓存
//
// 设计意图：
// DeepSeek 推理模型(如 R1)在多轮对话中要求 assistant 消息的 reasoning_content
// 字段必须在历史消息中原样回传。客户端可能不保留该字段，因此网关在响应后缓存
// reasoning_content，在下次请求转发前检测 assistant 消息中缺失 reasoning_content 时自动注入。
//
// 缓存策略：
// - content (string) → reasoning_content 的映射
// - 容量上限 1000 条，满时清空一半（LRU 近似）
// - 进程内存储，重启后丢失（不影响当轮对话）

const MAX_CACHE_SIZE = 1000;
const EVICT_COUNT = 500;

/** 推理内容缓存: content → reasoning_content */
const cache = new Map<string, string>();

/**
 * 缓存推理内容
 * content 为 assistant 消息的 content 文本（用作匹配键）
 * reasoningContent 为提供商返回的思考内容
 */
export function cacheReasoningContent(content: string | null, reasoningContent: string | undefined): void {
  if (typeof content !== 'string' || content.length === 0) {
    return;
  }
  if (typeof reasoningContent !== 'string' || reasoningContent.length === 0) {
    return;
  }

  if (cache.size >= MAX_CACHE_SIZE) {
    // 满时清空最旧的一半（Map 按插入顺序迭代）
    let evicted = 0;
    const keysToDelete: string[] = [];
    for (const key of cache.keys()) {
      keysToDelete.push(key);
      evicted++;
      if (evicted >= EVICT_COUNT) {
        break;
      }
    }
    for (const k of keysToDelete) {
      cache.delete(k);
    }
  }

  cache.set(content, reasoningContent);
}

/**
 * 查询推理内容缓存
 * 按 assistant content 文本查找之前缓存的 reasoning_content
 * content 为 null 或空字符串时返回 undefined
 */
export function getReasoningContent(content: string | null): string | undefined {
  if (typeof content !== 'string' || content.length === 0) {
    return undefined;
  }
  return cache.get(content);
}

/**
 * 清空缓存（主要用于测试）
 */
export function clearReasoningCache(): void {
  cache.clear();
}

/**
 * 获取当前缓存大小（用于诊断/测试）
 */
export function getReasoningCacheSize(): number {
  return cache.size;
}

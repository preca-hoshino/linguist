// src/providers/copilot/chat/fallback/endpoint-resolver.ts — supported_endpoints 解析器

import type { CopilotEndpointType } from './types';

/**
 * 根据模型的 supported_endpoints 列表解析应使用的端点类型
 *
 * 优先级（与 copilot-api 保持一致）：
 * 1. /chat/completions    → 'chat-completions'（OpenAI 格式，兼容性最佳）
 * 2. /v1/messages        → 'messages'（Anthropic 格式）
 * 3. /responses          → 'responses'（OpenAI Responses API 格式）
 * 4. 无匹配 / undefined  → 'chat-completions'（安全回退）
 *
 * @param supportedEndpoints - 来自 GET /models 响应的 supported_endpoints 字段
 * @returns 应使用的 CopilotEndpointType
 */
export function resolveEndpointType(supportedEndpoints: string[] | undefined): CopilotEndpointType {
  if (!Array.isArray(supportedEndpoints) || supportedEndpoints.length === 0) {
    return 'chat-completions';
  }

  const normalized = supportedEndpoints.map((ep) => normalizeEndpointPath(ep));

  if (normalized.includes('/chat/completions')) {
    return 'chat-completions';
  }
  if (normalized.includes('/v1/messages')) {
    return 'messages';
  }
  if (normalized.includes('/responses')) {
    return 'responses';
  }

  return 'chat-completions';
}

/**
 * 规范化端点路径，统一处理斜杠前缀和大小写
 * 例如 'chat/completions' → '/chat/completions'
 */
function normalizeEndpointPath(endpoint: string): string {
  const trimmed = endpoint.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

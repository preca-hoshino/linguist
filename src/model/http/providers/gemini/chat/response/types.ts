// src/providers/chat/gemini/response/types.ts — Gemini 响应相关类型定义

// ==================== Gemini 响应类型定义 ====================

/** Gemini 响应文本 part */
export interface GeminiTextPart {
  text?: string;
}

/** Gemini 响应函数调用 part */
export interface GeminiFunctionCallPart {
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
}

/** Gemini 思维链 part */
export interface GeminiThoughtPart {
  thought?: boolean;
  text?: string;
}

/** Gemini 响应 part 联合类型 */
export type GeminiResponsePart = GeminiTextPart & GeminiFunctionCallPart & GeminiThoughtPart;

/** Gemini candidate */
export interface GeminiCandidate {
  content?: {
    role: string;
    parts: GeminiResponsePart[];
  };
  finishReason?: string;
  tokenCount?: number;
  safetyRatings?: unknown[];
}

/** Gemini usage 元数据 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Gemini 完整响应结构 */
export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

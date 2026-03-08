// src/types/provider.ts — 提供商调用相关类型

/** HTTP 头部快照（兼容 Express IncomingHttpHeaders / OutgoingHttpHeaders） */
export type HttpHeaders = Record<string, string | string[] | undefined>;

/** 附着在 GatewayError 上的提供商错误详情（用于审计） */
export interface ProviderErrorDetail {
  /** 提供商返回的 HTTP 状态码 */
  statusCode: number;
  /** 提供商原始错误码 */
  errorCode?: string | undefined;
  /** 提供商原始响应体（文本） */
  rawBody: string;
}

/**
 * 提供商 HTTP 调用结果（非流式）
 * 将解析后的响应体与双向头部打包返回给 caller
 */
export interface ProviderCallResult {
  body: unknown;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

/**
 * 提供商流式调用结果
 * 返回原始 Response（调用方从 body 读取 SSE 流）以及请求头
 */
export interface ProviderStreamResult {
  response: globalThis.Response;
  requestHeaders: Record<string, string>;
}

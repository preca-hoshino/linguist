// src/mcp/providers/streamable-http-client.ts — Streamable HTTP 传输 MCP 客户端
// 实现 MCP 2025-06-18 规范的 Streamable HTTP 传输

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpProviderClient, replaceApiKeyInObject, replaceApiKeyMarker } from './base-client';

/**
 * Streamable HTTP 传输方式的 MCP Provider 客户端
 *
 * 实现标准 MCP 2025-06-18 规范：
 * 通过 POST 发送 JSON-RPC，响应可选 SSE 流或 JSON。
 *
 * 传输配置从对称字段中读取：
 *   - provider.base_url：端点 URL（对称 model_providers.base_url）
 *   - provider.config.headers：自定义请求头
 */
export class StreamableHttpMcpClient extends McpProviderClient {
  protected createTransport(apiKey: string | undefined): Transport {
    const url = replaceApiKeyMarker(this.provider.base_url, apiKey);
    const headers = replaceApiKeyInObject(this.provider.config.headers ?? {}, apiKey);

    // 使用 as unknown as Transport 绕过 exactOptionalPropertyTypes 下的 sessionId 类型不兼容
    return new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: headers,
      },
    }) as unknown as Transport;
  }
}

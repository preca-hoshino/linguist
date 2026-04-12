// src/mcp/providers/sse-client.ts — SSE 传输 MCP 客户端
// 兼容 MCP 2024-11-05 规范的旧式 HTTP+SSE 传输

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpProviderClient, replaceApiKeyInObject, replaceApiKeyMarker } from './base-client';

/**
 * SSE 传输方式的 MCP Provider 客户端
 *
 * 用于兼容旧版 MCP Server（2024-11-05 规范），
 * 通过 GET /sse + POST /messages 方式通信。
 */
export class SseMcpClient extends McpProviderClient {
  protected createTransport(apiKey: string | undefined): Transport {
    const url = replaceApiKeyMarker(this.provider.endpoint_url, apiKey);
    const headers = replaceApiKeyInObject(this.provider.headers, apiKey);

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- SSE 传输用于兼容旧版 MCP Server
    return new SSEClientTransport(new URL(url), {
      requestInit: {
        headers: headers,
      },
    });
  }
}

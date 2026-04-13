// src/mcp/providers/stdio-client.ts — Stdio 传输 MCP 客户端
// 通过子进程 stdin/stdout 与本地 MCP Server 通信

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpProviderClient, replaceApiKeyInObject, replaceApiKeyMarker } from './base-client';

/**
 * Stdio 传输方式的 MCP Provider 客户端
 *
 * 与 Claude Desktop 等标准 MCP Host 的行为一致：
 * 启动子进程，通过 stdin/stdout 交换 JSON-RPC 消息。
 */
export class StdioMcpClient extends McpProviderClient {
  protected createTransport(apiKey: string | undefined): Transport {
    const command = replaceApiKeyMarker(this.provider.stdio_command, apiKey);
    const args = replaceApiKeyInObject(this.provider.stdio_args, apiKey);
    const envOverrides = replaceApiKeyInObject(this.provider.stdio_env, apiKey);

    // 合并环境变量并过滤 undefined 值
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }
    for (const [key, value] of Object.entries(envOverrides)) {
      mergedEnv[key] = value;
    }

    return new StdioClientTransport({
      command,
      args,
      env: mergedEnv,
    });
  }
}

// src/mcp/providers/connection-manager.ts — MCP Provider 连接池管理
// 按需建联 + 缓存复用 + 空闲超时自动清理

import type { McpProviderRow } from '@/db/mcp-providers/types';
import { createLogger, logColors } from '@/utils';
import type { McpProviderClient } from './base-client';
import { SseMcpClient } from './sse-client';
import { StdioMcpClient } from './stdio-client';
import { StreamableHttpMcpClient } from './streamable-http-client';

const logger = createLogger('McpConnMgr', logColors.magenta);

/** 连接池条目 */
interface ConnectionEntry {
  client: McpProviderClient;
  lastUsedAt: number;
}

/** 空闲超时（5 分钟，与 Claude Desktop 一致） */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** 清理检查间隔（60 秒） */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * MCP Provider 连接池管理器
 *
 * - getClient(): 从缓存获取或新建连接
 * - 空闲超时检测：超过 5 分钟无使用自动断开
 * - 手动移除与全部断开
 */
export class McpConnectionManager {
  private readonly connections = new Map<string, ConnectionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 应用 API Key 凭证缓存池并替换 {{APIKEY}} 变量
   */
  private applyApiKeyTemplate(provider: McpProviderRow): McpProviderRow {
    if (provider.api_keys.length === 0) {
      return provider;
    }

    const key = provider.api_keys[Math.floor(Math.random() * provider.api_keys.length)] ?? '';
    const clone = { ...provider };
    const replaceKey = (str: string): string => str.replace(/\{\{APIKEY\}\}/g, key);

    clone.endpoint_url = replaceKey(clone.endpoint_url);
    clone.stdio_command = replaceKey(clone.stdio_command);
    const args = Array.isArray(clone.stdio_args) ? clone.stdio_args : [];
    clone.stdio_args = args.map((arg) => (typeof arg === 'string' ? replaceKey(arg) : arg));

    clone.headers = { ...clone.headers };
    for (const [k, v] of Object.entries(clone.headers)) {
      if (typeof v === 'string') {
        clone.headers[k] = replaceKey(v);
      }
    }

    clone.stdio_env = { ...clone.stdio_env };
    for (const [k, v] of Object.entries(clone.stdio_env)) {
      if (typeof v === 'string') {
        clone.stdio_env[k] = replaceKey(v);
      }
    }

    return clone;
  }

  /**
   * 根据 Provider 配置创建对应传输类型的客户端
   */
  private createClient(provider: McpProviderRow): McpProviderClient {
    const instantiatedProvider = this.applyApiKeyTemplate(provider);
    switch (instantiatedProvider.transport_type) {
      case 'stdio':
        return new StdioMcpClient(instantiatedProvider);
      case 'sse':
        return new SseMcpClient(instantiatedProvider);
      case 'streamable_http':
        return new StreamableHttpMcpClient(instantiatedProvider);
      default:
        throw new Error(`Unsupported transport type: ${provider.transport_type}`);
    }
  }

  /**
   * 启动空闲连接清理定时器
   */
  private ensureCleanupTimer(): void {
    if (this.cleanupTimer !== null) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleConnections();
    }, CLEANUP_INTERVAL_MS);

    // 允许进程正常退出
    this.cleanupTimer.unref();
  }

  /**
   * 清理空闲连接
   */
  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, entry] of this.connections) {
      if (now - entry.lastUsedAt > IDLE_TIMEOUT_MS) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      await this.removeClient(id);
      logger.debug({ providerId: id }, 'Idle MCP connection cleaned up');
    }
  }

  /**
   * 获取或创建 Provider 客户端（按需建联 + 缓存复用）
   */
  public async getClient(provider: McpProviderRow): Promise<McpProviderClient> {
    const existing = this.connections.get(provider.id);
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }

    const client = this.createClient(provider);
    await client.connect();

    this.connections.set(provider.id, {
      client,
      lastUsedAt: Date.now(),
    });

    this.ensureCleanupTimer();
    logger.info({ providerId: provider.id, transport: provider.transport_type }, 'MCP client cached');
    return client;
  }

  /**
   * 移除并断开指定 Provider 的客户端
   */
  public async removeClient(providerId: string): Promise<void> {
    const entry = this.connections.get(providerId);
    if (entry === undefined) {
      return;
    }

    try {
      await entry.client.disconnect();
    } catch (error) {
      logger.warn(
        { providerId, err: error instanceof Error ? error.message : String(error) },
        'Error removing MCP client',
      );
    }

    this.connections.delete(providerId);
  }

  /**
   * 断开所有连接（服务关闭时调用）
   */
  public async disconnectAll(): Promise<void> {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const ids = [...this.connections.keys()];
    for (const id of ids) {
      await this.removeClient(id);
    }

    logger.info('All MCP provider connections closed');
  }
}

/** 全局单例 */
export const mcpConnectionManager: McpConnectionManager = new McpConnectionManager();

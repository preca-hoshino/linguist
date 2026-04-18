// src/mcp/providers/base-client.ts — MCP Provider 客户端抽象基类
// 封装 @modelcontextprotocol/sdk Client，处理 {{APIKEY}} 标记替换和连接生命周期

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpProviderRow } from '@/db/mcp-providers/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('McpClient', logColors.magenta);

/** MCP 工具定义（从 SDK 获取的原始格式） */
export interface McpToolInfo {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果 */
export interface McpCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean | undefined;
}

/**
 * 从 API Key 池中轮询选取下一个 Key
 * 使用简单的循环计数器实现
 */
const keyCounters = new Map<string, number>();

export function getNextApiKey(providerId: string, apiKeys: string[]): string | undefined {
  if (apiKeys.length === 0) {
    return undefined;
  }
  const counter = keyCounters.get(providerId) ?? 0;
  const key = apiKeys[counter % apiKeys.length];
  keyCounters.set(providerId, counter + 1);
  return key;
}

/**
 * 将字符串中的所有 {{APIKEY}} 标记替换为实际的 API Key
 */
export function replaceApiKeyMarker(value: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === '') {
    return value;
  }
  return value.replaceAll('{{APIKEY}}', apiKey);
}

/**
 * 递归替换对象中所有字符串值的 {{APIKEY}} 标记
 */
export function replaceApiKeyInObject<T>(obj: T, apiKey: string | undefined): T {
  if (apiKey === undefined || apiKey === '') {
    return obj;
  }
  if (typeof obj === 'string') {
    return replaceApiKeyMarker(obj, apiKey) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item: unknown) => replaceApiKeyInObject(item, apiKey)) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceApiKeyInObject(value, apiKey);
    }
    return result as T;
  }
  return obj;
}

/**
 * MCP Provider 客户端抽象基类
 *
 * 子类需实现 createTransport() 方法，返回对应传输层的 Transport 实例。
 * 基类负责：Client 实例化、连接管理、tools/list、tools/call 的统一调用。
 */
export abstract class McpProviderClient {
  protected client: Client;
  protected transport: Transport | null = null;
  protected connected = false;
  protected readonly provider: McpProviderRow;

  public constructor(provider: McpProviderRow) {
    this.provider = provider;
    this.client = new Client({ name: `linguist-gateway/${provider.id}`, version: '1.0.0' }, { capabilities: {} });
  }

  /** 获取当前连接状态 */
  public get isConnected(): boolean {
    return this.connected;
  }

  /** 获取提供商 ID */
  public get providerId(): string {
    return this.provider.id;
  }

  /**
   * 子类实现：创建对应传输层的 Transport 实例
   * @param apiKey 当前轮询到的 API Key（可能为 undefined）
   */
  protected abstract createTransport(apiKey: string | undefined): Transport;

  /**
   * 建立连接
   * 从 credential（API Key 池数组）中轮询选取 Key
   */
  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // credential 字段存储 API Key 池，与 model_providers.credential 对称
    const apiKey = getNextApiKey(this.provider.id, this.provider.credential);
    this.transport = this.createTransport(apiKey);
    await this.client.connect(this.transport);
    this.connected = true;

    logger.info({ providerId: this.provider.id, name: this.provider.name }, 'MCP provider connected');
  }

  /**
   * 断开连接
   */
  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.client.close();
    } catch (error) {
      logger.warn(
        { providerId: this.provider.id, err: error instanceof Error ? error.message : String(error) },
        'Error during MCP provider disconnect',
      );
    }

    this.transport = null;
    this.connected = false;
    logger.info({ providerId: this.provider.id }, 'MCP provider disconnected');
  }

  /**
   * 确保已连接（按需建联）
   */
  protected async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  /**
   * 列出工具
   */
  public async listTools(): Promise<McpToolInfo[]> {
    await this.ensureConnected();
    const result = await this.client.listTools();
    return result.tools as McpToolInfo[];
  }

  /**
   * 调用工具
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ensureConnected();
    const result = await this.client.callTool({ name, arguments: args });
    return result as McpCallResult;
  }
}

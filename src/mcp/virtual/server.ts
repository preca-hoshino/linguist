// src/mcp/virtual/server.ts — 虚拟 MCP Server 聚合层

import * as crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { insertMcpLog } from '@/db/mcp-logs';
import { getMcpProviderById } from '@/db/mcp-providers';
import type { VirtualMcpRow } from '@/db/mcp-virtual-servers';
import { createLogger, logColors } from '@/utils';
import { mcpConnectionManager } from '../providers/connection-manager';
import { filterTools, isToolAllowed } from './tool-registry';

const logger = createLogger('VirtualMcpServer', logColors.blue);

/** 会话管理 */
export interface McpSession {
  sessionId: string;
  virtualMcpId: string;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  transport: SSEServerTransport;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  server: Server;
  createdAt: number;
}

const activeSessions = new Map<string, McpSession>();

/** 会话清理超时（小时） */
const SESSION_CLEANUP_MS = 2 * 60 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
      if (now - session.createdAt > SESSION_CLEANUP_MS) {
        activeSessions.delete(id);
      }
    }
  },
  60 * 60 * 1000,
).unref();

/**
 * 记录日志帮助函数
 */
async function logMcp(
  virtualId: string,
  providerId: string,
  appId: string | undefined,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  error: Record<string, unknown> | undefined,
  durationMs: number,
): Promise<void> {
  const id = crypto.randomUUID();
  await insertMcpLog({
    id,
    virtual_mcp_id: virtualId,
    mcp_provider_id: providerId,
    app_id: appId,
    session_id: sessionId,
    method,
    params,
    result,
    error,
    duration_ms: durationMs,
  });
}

interface AuthenticatedRequest extends Request {
  appId?: string;
}

/**
 * 处理客户端通过 SSE 建立连接请求
 * virtualMcp 由路由层预先解析并校验（含存活性检查），此处直接使用
 */
export async function handleMcpSseConnect(req: Request, res: Response, virtualMcp: VirtualMcpRow): Promise<void> {
  // 验证关联的 Provider 是否有效
  const provider = await getMcpProviderById(virtualMcp.mcp_provider_id);
  if (!provider) {
    res.status(500).json({ error: 'Associated MCP provider not found' });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const transport = new SSEServerTransport('/mcp/messages', res);
  // transport provides its own generated session ID
  const sessionId = transport.sessionId;

  // 2. 建立 SDK Server 实例
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 忽略由 SDK 引发的弃用警告
  const server = new Server(
    { name: `linguist-virtual/${virtualMcp.name}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // 工具白名单来自 virtualMcp.config.tools（config JSONB 字段）
  const allowedTools = virtualMcp.config.tools ?? [];

  // 3. 注册 tools/list 处理程序
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const start = Date.now();
    try {
      const client = await mcpConnectionManager.getClient(provider);
      const tools = await client.listTools();

      // 根据 ACL 过滤
      const filtered = filterTools(tools, allowedTools);

      const result = { tools: filtered };
      await logMcp(
        virtualMcp.id,
        provider.id,
        (req as AuthenticatedRequest).appId,
        sessionId,
        'tools/list',
        {},
        result,
        undefined,
        Date.now() - start,
      );
      return result;
    } catch (err) {
      const errObj = { message: err instanceof Error ? err.message : String(err) };
      await logMcp(
        virtualMcp.id,
        provider.id,
        (req as AuthenticatedRequest).appId,
        sessionId,
        'tools/list',
        {},
        {},
        errObj,
        Date.now() - start,
      );
      throw err;
    }
  });

  // 4. 注册 tools/call 处理程序
  // @ts-expect-error SDK type signature expects ServerResult but we return custom object
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const start = Date.now();
    const name = request.params.name;
    const args = request.params.arguments;
    const params = { name, arguments: args };

    try {
      // 检查 ACL 是否允许
      if (!isToolAllowed(name, allowedTools)) {
        throw new Error(`Tool call denied by ACL: ${name}`);
      }

      const client = await mcpConnectionManager.getClient(provider);
      const result = await client.callTool(name, args as Record<string, unknown>);

      await logMcp(
        virtualMcp.id,
        provider.id,
        (req as AuthenticatedRequest).appId,
        sessionId,
        'tools/call',
        params,
        result as unknown as Record<string, unknown>,
        undefined,
        Date.now() - start,
      );
      return result;
    } catch (err) {
      const errObj = { message: err instanceof Error ? err.message : String(err) };
      await logMcp(
        virtualMcp.id,
        provider.id,
        (req as AuthenticatedRequest).appId,
        sessionId,
        'tools/call',
        params,
        {},
        errObj,
        Date.now() - start,
      );
      throw err;
    }
  });

  // Store in cache BEFORE connecting so that if client connects quickly, it doesn't 404
  activeSessions.set(sessionId, {
    sessionId,
    virtualMcpId: virtualMcp.id,
    transport,
    server,
    createdAt: Date.now(),
  });

  await server.connect(transport);

  logger.info({ virtualMcpId: virtualMcp.id, sessionId }, 'Virtual MCP SSE session established');
}

/**
 * 接收客户端发送的 JSON-RPC 消息
 */
export async function handleMcpMessage(req: Request, res: Response): Promise<void> {
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId === undefined || sessionId === '') {
    res.status(400).json({ error: 'sessionId query parameter is required' });
    return;
  }

  const session = activeSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (req.body === undefined) {
    res.status(500).json({ error: 'req.body is undefined' });
    return;
  }
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    logger.error({ err, sessionId }, 'Error handling MCP message');
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

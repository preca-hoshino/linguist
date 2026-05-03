// src/mcp/virtual/server.ts — 虚拟 MCP Server 聚合层（Streamable HTTP）

import * as crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { insertMcpLog } from '@/db/mcp-logs';
import { getMcpProviderById } from '@/db/mcp-providers';
import type { McpProviderRow } from '@/db/mcp-providers/types';
import type { VirtualMcpRow } from '@/db/mcp-virtual-servers';
import type { McpGatewayContext } from '@/types';
import { createLogger, logColors } from '@/utils';
import { mcpConnectionManager } from '../providers/connection-manager';
import { filterTools, isToolAllowed } from './tool-registry';

const logger = createLogger('VirtualMcpServer', logColors.blue);

/**
 * 每次请求携带的会话上下文。
 * 注入到 req.auth，由 transport 通过 extra.authInfo 传递至 Server handler。
 */
export interface MCPRequestAuth {
  virtualMcpId: string;
  virtualMcpName: string;
  mcpProviderId: string;
  appId?: string | undefined;
  allowedTools: string[];
  provider: McpProviderRow;
  sessionId: string;
  /** HTTP 请求追踪 ID（由路由层注入，与 X-Request-Id 响应头一致） */
  requestId: string;
}

/** 会话管理 */
export interface McpSession {
  sessionId: string;
  virtualMcpId: string;
  transport: StreamableHTTPServerTransport;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server 用于低级别 JSON-RPC handler 注册，非 McpServer 高级 API 场景
  server: Server;
  auth: MCPRequestAuth;
  createdAt: number;
}

const activeSessions = new Map<string, McpSession>();

/** 会话清理超时（2 小时） */
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
 * 创建工具审计上下文
 */
function buildAuditContext(
  auth: MCPRequestAuth,
  method: 'tools/list' | 'tools/call',
  toolName?: string,
): McpGatewayContext {
  return {
    id: auth.requestId,
    virtualMcpId: auth.virtualMcpId,
    virtualMcpName: auth.virtualMcpName,
    mcpProviderId: auth.mcpProviderId,
    appId: auth.appId,
    sessionId: auth.sessionId,
    method,
    toolName,
    status: 'completed',
    audit: {
      userRequest: { body: { method } },
      providerRequest: { body: { method } },
    },
    timing: { start: Date.now() },
  };
}

/**
 * 为新连接创建 MCP Server 实例并注册 tools/list / tools/call 处理程序。
 * 所有运行时上下文（virtualMcpId、allowedTools 等）通过 extra.authInfo 获取，
 * 不再通过闭包捕获 req 对象。
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- 低级别 JSON-RPC handler 注册场景，需直接使用 Server
function createMcpServerInstance(): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server({ name: 'linguist-virtual', version: '1.0.0' }, { capabilities: { tools: {} } });

  // tools/list 处理程序
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const auth = (extra as Record<string, unknown> | undefined)?.authInfo as MCPRequestAuth | undefined;
    if (auth === undefined) {
      throw new Error('Missing session auth context');
    }

    const ctx = buildAuditContext(auth, 'tools/list');

    try {
      const client = await mcpConnectionManager.getClient(auth.provider);
      const tools = await client.listTools();
      const filtered = filterTools(tools, auth.allowedTools);
      const result = { tools: filtered };

      ctx.audit.providerResponse = { body: { tools } };
      ctx.audit.userResponse = { body: result };
      ctx.timing.end = Date.now();
      await insertMcpLog(ctx);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.status = 'error';
      ctx.errorMessage = message;
      ctx.audit.userResponse = { body: { error: { message } } };
      ctx.timing.end = Date.now();
      await insertMcpLog(ctx);
      throw err;
    }
  });

  // tools/call 处理程序
  // @ts-expect-error SDK type signature expects ServerResult but we return custom object
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const auth = (extra as Record<string, unknown> | undefined)?.authInfo as MCPRequestAuth | undefined;
    if (auth === undefined) {
      throw new Error('Missing session auth context');
    }

    const name = request.params.name;
    const args = request.params.arguments;
    const ctx = buildAuditContext(auth, 'tools/call', name);

    try {
      if (!isToolAllowed(name, auth.allowedTools)) {
        throw new Error(`Tool call denied by ACL: ${name}`);
      }

      const client = await mcpConnectionManager.getClient(auth.provider);
      const result = await client.callTool(name, args as Record<string, unknown>);

      ctx.audit.providerResponse = { body: result as unknown as Record<string, unknown> };
      ctx.audit.userResponse = { body: result as unknown as Record<string, unknown> };
      ctx.timing.end = Date.now();
      await insertMcpLog(ctx);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.status = 'error';
      ctx.errorMessage = message;
      ctx.audit.userResponse = { body: { error: { message } } };
      ctx.timing.end = Date.now();
      await insertMcpLog(ctx);
      throw err;
    }
  });

  return server;
}

/**
 * 创建新的 MCP 会话并处理首次请求。
 * 鉴权与白名单校验由路由层完成，本函数专注于 Server / Transport 生命周期。
 */
export async function createMcpSession(
  req: Request,
  res: Response,
  virtualMcp: VirtualMcpRow,
  appId: string | undefined,
): Promise<void> {
  const provider = await getMcpProviderById(virtualMcp.mcp_provider_id);
  if (!provider) {
    res.status(500).json({ error: 'Associated MCP provider not found' });
    return;
  }

  const allowedTools: string[] = virtualMcp.config.tools ?? [];

  // 会话上下文 sessionId 将在 transport 初始化后回填
  const requestId = (req as unknown as Record<string, unknown>).mcpRequestId as string | undefined;
  const auth: MCPRequestAuth = {
    virtualMcpId: virtualMcp.id,
    virtualMcpName: virtualMcp.name,
    mcpProviderId: provider.id,
    appId,
    allowedTools,
    provider,
    sessionId: '',
    requestId: requestId ?? crypto.randomUUID(),
  };

  const server = createMcpServerInstance();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: (): string => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string): void => {
      auth.sessionId = sessionId;
      activeSessions.set(sessionId, {
        sessionId,
        virtualMcpId: virtualMcp.id,
        transport,
        server,
        auth,
        createdAt: Date.now(),
      });
      logger.info({ virtualMcpId: virtualMcp.id, sessionId }, 'MCP session initialized');
    },
  });

  transport.onclose = (): void => {
    const sid = transport.sessionId;
    if (sid !== undefined && sid !== '') {
      activeSessions.delete(sid);
      logger.info({ sessionId: sid }, 'MCP session closed');
    }
  };

  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  // 注入会话上下文至 req.auth，由 transport 通过 extra.authInfo → Server handler
  (req as unknown as Record<string, unknown>).auth = auth;

  await transport.handleRequest(req, res, req.body);
}

/**
 * 处理已有会话的后续请求（GET / POST / DELETE）。
 */
export async function handleMcpRequest(req: Request, res: Response, session: McpSession): Promise<void> {
  // 按请求覆盖 requestId（同一会话的每次 HTTP 请求有独立追踪 ID）
  const requestId = (req as unknown as Record<string, unknown>).mcpRequestId as string | undefined;
  (req as unknown as Record<string, unknown>).auth = {
    ...session.auth,
    ...(requestId !== undefined ? { requestId } : {}),
  };
  await session.transport.handleRequest(req, res, req.body);
}

/**
 * 按 sessionId 查找活跃会话。
 */
export function getSession(sessionId: string): McpSession | undefined {
  return activeSessions.get(sessionId);
}

// src/api/http/mcp/index.ts — MCP 网关 HTTP 路由处理（Streamable HTTP）

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { getVirtualMcpByName } from '@/db/mcp-virtual-servers';
import { createMcpSession, getSession, handleMcpRequest } from '@/mcp';
import { GatewayError } from '@/utils';
import { validateApiKeyFromRequest } from '../auth-helper';

export const mcpRouter: Router = Router();

/**
 * 统一 MCP Streamable HTTP 端点。
 * ALL /mcp/sse — 同时处理 GET（SSE 流）、POST（JSON-RPC 消息）和 DELETE（终止会话）。
 *
 * - 首次请求（无 mcp-session-id header）：鉴权 → 创建会话 → 处理 initialize
 * - 后续请求（有 mcp-session-id header）：复用已有会话
 * - 外部调用方通过 X-Mcp-Name header 指定虚拟 MCP 名字
 */
mcpRouter.all('/mcp/sse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. 有 mcp-session-id → 复用已有会话
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessionId) {
      const session = getSession(sessionId);
      if (session) {
        await handleMcpRequest(req, res, session);
        return;
      }
      res.status(404).json({
        error: { code: 'session_not_found', message: 'Session not found or expired' },
      });
      return;
    }

    // 2. 无 session → 鉴权 + 创建新会话
    const mcpNameRaw = req.headers['x-mcp-name'];
    const mcpName = typeof mcpNameRaw === 'string' ? mcpNameRaw.trim() : '';
    if (!mcpName) {
      res.status(400).json({
        error: { code: 'invalid_request', message: 'X-Mcp-Name header is required' },
      });
      return;
    }

    const virtualMcp = await getVirtualMcpByName(mcpName);
    if (!virtualMcp) {
      res.status(404).json({
        error: { code: 'not_found', message: `Virtual MCP not found: ${mcpName}` },
      });
      return;
    }

    const appEntry = await validateApiKeyFromRequest(req, (r) => {
      const authHeader = r.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
      }
      if (typeof r.query.key === 'string' && r.query.key) {
        return r.query.key;
      }
      return undefined;
    });

    const requireApiKey = process.env.REQUIRE_API_KEY !== 'false';
    if (requireApiKey && appEntry !== undefined) {
      if (!appEntry.allowedMcpIds.includes(virtualMcp.id)) {
        throw new GatewayError(403, 'forbidden', `App does not have access to virtual MCP: ${mcpName}`);
      }
    }

    await createMcpSession(req, res, virtualMcp, appEntry?.id);
  } catch (err) {
    next(err);
  }
});

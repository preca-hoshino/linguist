// src/api/http/mcp/index.ts — MCP 网关 HTTP 路由处理

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { handleMcpMessage, handleMcpSseConnect } from '@/mcp';
import { validateApiKeyFromRequest } from '../auth-helper';
import { lookupAppByKey } from '@/db/apps';
import { GatewayError } from '@/utils';

export const mcpRouter: Router = Router();

interface AuthenticatedRequest extends Request {
  appId?: string;
}

// ==========================================
// Virtual MCP Endpoints
// ==========================================

/**
 * 建立 SSE 连接 (MCP Server 规范)
 * GET /mcp/:virtualMcpId/sse
 */
mcpRouter.get('/mcp/:virtualMcpId/sse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { virtualMcpId } = req.params;

    // 1. 验证 API Key
    await validateApiKeyFromRequest(req, (r) => {
      const authHeader = r.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
      }
      if (typeof r.query.key === 'string' && r.query.key) {
        return r.query.key;
      }
      return undefined;
    });

    // 2. 鉴权：检查应用是否允许访问该虚拟 MCP
    const requireApiKey = process.env.REQUIRE_API_KEY !== 'false';
    if (requireApiKey) {
      const apiKey = req.headers.authorization?.substring(7).trim() ?? (req.query.key as string);
      const app = await lookupAppByKey(apiKey);

      if (!app?.allowedMcpIds.includes(String(virtualMcpId))) {
        throw new GatewayError(403, 'forbidden', `App does not have access to virtual MCP: ${String(virtualMcpId)}`);
      }

      // 将 appId 注入 request 提供给下游处理逻辑和日志
      (req as AuthenticatedRequest).appId = app.id;
    }

    // 3. 建立连接
    await handleMcpSseConnect(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * 接收 JSON-RPC 消息 (MCP Server 规范)
 * POST /mcp/messages?sessionId=...
 * 注：由于 Session 已经和 appId 以及 virtualMcpId 绑定，这里无需再次鉴权
 */
mcpRouter.post('/mcp/messages', (req: Request, res: Response, next: NextFunction) => {
  handleMcpMessage(req, res).catch(next);
});

// src/api/http/mcp/index.ts — MCP 网关 HTTP 路由处理

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { getVirtualMcpByName } from '@/db/mcp-virtual-servers';
import { handleMcpMessage, handleMcpSseConnect } from '@/mcp';
import { GatewayError } from '@/utils';
import { validateApiKeyFromRequest } from '../auth-helper';

export const mcpRouter: Router = Router();

interface AuthenticatedRequest extends Request {
  appId?: string;
}

// ==========================================
// Virtual MCP Endpoints
// ==========================================

/**
 * 建立 SSE 连接 (MCP Server 规范)
 * GET /mcp/sse
 *
 * 外部调用方通过 X-Mcp-Name header 指定虚拟 MCP 的用户自定义名字，
 * 与虚拟模型通过 body.model 传名字的心智模型保持一致。
 * 路由层负责：name → 内部 ID 解析、活跃性检查、App 白名单校验。
 */
mcpRouter.get('/mcp/sse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. 从 Header 读取虚拟 MCP 名字（外部调用用名字，不暴露内部 ID）
    const mcpNameRaw = req.headers['x-mcp-name'];
    const mcpName = typeof mcpNameRaw === 'string' ? mcpNameRaw.trim() : '';
    if (!mcpName) {
      res.status(400).json({ error: { code: 'invalid_request', message: 'X-Mcp-Name header is required' } });
      return;
    }

    // 2. 通过名字反查虚拟 MCP（含活跃性过滤）
    const virtualMcp = await getVirtualMcpByName(mcpName);
    if (!virtualMcp) {
      res.status(404).json({ error: { code: 'not_found', message: `Virtual MCP not found: ${mcpName}` } });
      return;
    }

    // 3. 验证 API Key 并获取 App 信息
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

    // 4. 白名单校验：用内部 ID 比对（AppCacheEntry.allowedMcpIds 存内部 ID）
    const requireApiKey = process.env.REQUIRE_API_KEY !== 'false';
    if (requireApiKey && appEntry !== undefined) {
      if (!appEntry.allowedMcpIds.includes(virtualMcp.id)) {
        throw new GatewayError(403, 'forbidden', `App does not have access to virtual MCP: ${mcpName}`);
      }
      // 将 appId 注入 request 提供给下游处理逻辑和日志
      (req as AuthenticatedRequest).appId = appEntry.id;
    }

    // 5. 建立连接（传入预解析好的 virtualMcp，避免 server.ts 重复查询）
    await handleMcpSseConnect(req, res, virtualMcp);
  } catch (err) {
    next(err);
  }
});

/**
 * 接收 JSON-RPC 消息 (MCP Server 规范)
 * POST /mcp/messages?sessionId=...
 * 注：Session 已在建立连接时与 appId 及 virtualMcpId 绑定，这里无需再次鉴权
 */
mcpRouter.post('/mcp/messages', (req: Request, res: Response, next: NextFunction) => {
  handleMcpMessage(req, res).catch(next);
});

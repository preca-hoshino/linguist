// src/api/http/mcp/index.ts — MCP 网关 HTTP 路由处理

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { handleMcpMessage, handleMcpSseConnect } from '@/mcp';

export const mcpRouter: Router = Router();

// ==========================================
// Virtual MCP Endpoints
// ==========================================

/**
 * 建立 SSE 连接 (MCP Server 规范)
 * GET /mcp/:virtualMcpId/sse
 * GET /mcp/sse (通过 Authorization Bearer 或 Query Parameter 提供 ID)
 */
mcpRouter.get('/mcp/sse', (req: Request, res: Response, next: NextFunction) => {
  handleMcpSseConnect(req, res).catch(next);
});

mcpRouter.get('/mcp/:virtualMcpId/sse', (req: Request, res: Response, next: NextFunction) => {
  handleMcpSseConnect(req, res).catch(next);
});

/**
 * 接收 JSON-RPC 消息 (MCP Server 规范)
 * POST /mcp/messages?sessionId=...
 */
mcpRouter.post('/mcp/messages', (req: Request, res: Response, next: NextFunction) => {
  handleMcpMessage(req, res).catch(next);
});

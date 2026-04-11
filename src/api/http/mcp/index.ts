// src/api/http/mcp/index.ts — MCP HTTP 端点占位路由

// TODO: Phase 4 实现工具清单与调用转发
import { Router } from 'express';

const mcpRouter: Router = Router();

// GET /v1/mcp/tools — 返回虚拟 MCP Server 工具清单（待实现）
mcpRouter.get('/v1/mcp/tools', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', message: 'MCP gateway is not yet implemented' });
});

// POST /v1/mcp/tools/call — 调用指定工具（待实现）
mcpRouter.post('/v1/mcp/tools/call', (_req, res) => {
  res.status(501).json({ error: 'not_implemented', message: 'MCP gateway is not yet implemented' });
});

export { mcpRouter };

import type { Request, Response } from 'express';
import express from 'express';
import { adminRouter } from './admin';
import { loginRouter } from './admin/login';
import { apiRouter } from './api';
import { handleError } from './model/http/users';
import { createLogger, GatewayError, logColors } from './utils';

/** HTTP 服务日志器 */
const logger: ReturnType<typeof createLogger> = createLogger('Server', logColors.bold + logColors.blue);

/** Express 应用实例 — 配置基础中间件、路由挂载和 404 处理 */
const app: express.Application = express();
app.disable('x-powered-by'); // 禁止泄露框架信息

// ==================== 请求跟踪日志 ====================
app.use((req: Request, _res: Response, next) => {
  logger.debug({ method: req.method, path: req.path, ip: req.ip }, 'Incoming request');
  next();
});

// ==================== 基础中间件 ====================
app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));

// ==================== 健康检查 ====================
app.get('/api/health', (_req: Request, res: Response) => {
  logger.debug('Health check requested');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ==================== 登录端点（无需鉴权） ====================
app.use('/api', loginRouter);

// ==================== 管理 API ====================
app.use('/api', adminRouter);

// ==================== 用户 API 路由（各格式模块自行定义路径） ====================
app.use(apiRouter);

// ==================== 404 处理 ====================
app.use((req: Request, res: Response) => {
  logger.warn({ method: req.method, path: req.path }, 'Route not found');
  const format = req.path.startsWith('/v1beta/') ? 'gemini' : undefined;
  handleError(new GatewayError(404, 'not_found', 'Not Found'), res, format);
});

export { app };

import 'dotenv/config';
import { app } from './server';
import { createLogger, logColors } from './utils';
import { configManager } from './config';
import { closePool, runMigrations } from './db';

const logger = createLogger('Startup', logColors.bold + logColors.green);

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

/** 初始化并启动网关服务（数据库迁移 → 加载配置 → 启动 DB 监听 → 启动 HTTP → 注册优雅关闭） */
async function start(): Promise<void> {
  try {
    logger.info('Initializing Linguist LLM Gateway...');

    // 运行数据库迁移（幂等，确保表结构最新）
    await runMigrations();
    logger.info('Database migrations applied successfully');

    // 加载配置
    await configManager.loadAll();
    logger.info('Configuration loaded successfully');

    // 启动 LISTEN/NOTIFY 监听
    await configManager.startListening();
    logger.info('Database change listener started');

    // 启动 HTTP 服务
    const server = app.listen(PORT, () => {
      logger.info({ port: PORT }, 'Linguist LLM Gateway started');
      logger.info(`Health check: http://localhost:${PORT}/api/health`);
      logger.info(`Chat completions: POST http://localhost:${PORT}/v1/chat/completions`);
    });

    // 配置请求超时（10 分钟），以支持高级模型的长时间思考
    server.requestTimeout = 600_000;
    server.headersTimeout = 620_000; // 略大于 requestTimeout

    // 优雅关闭
    let isShuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;
      logger.info('Shutting down gracefully...');
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      logger.info('HTTP server closed');
      await configManager.stopListening();
      logger.info('Config listener stopped');
      await closePool();
      logger.info('Database pool closed. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', () => {
      logger.info('Received SIGINT signal');
      void shutdown();
    });
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM signal');
      void shutdown();
    });
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)), 'Failed to start server');
    await closePool();
    process.exit(1);
  }
}

void start();

import 'dotenv/config';
import { configManager } from './config';
import { closePool, countUsers, createUser, runMigrations } from './db';
import { app } from './server';
import { createLogger, logColors, rateLimiter } from './utils';

const logger = createLogger('Startup', logColors.bold + logColors.green);

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

/** 初始化种子管理员账号（users 表为空时自动创建） */
async function seedAdminUser(): Promise<void> {
  const count = await countUsers();
  if (count > 0) {
    logger.info(`Found ${count} existing user(s), skipping seed`);
    return;
  }

  const email = process.env.ADMIN_EMAIL ?? 'admin@linguist.local';
  const password = process.env.ADMIN_PASSWORD ?? 'Admin@123456';
  const username = 'admin';

  const user = await createUser({ username, email, password });
  logger.info({ userId: user.id, username, email }, 'Seed admin user created');

  if (process.env.ADMIN_EMAIL === undefined || process.env.ADMIN_PASSWORD === undefined) {
    logger.warn('⚠️  Using default admin credentials. Change them in .env (ADMIN_EMAIL / ADMIN_PASSWORD)');
  }
}

/** 初始化并启动网关服务（数据库迁移 → 种子 → 加载配置 → 启动 DB 监听 → 启动 HTTP → 注册优雅关闭） */
async function start(): Promise<void> {
  try {
    logger.info('Initializing Linguist LLM Gateway...');

    // 运行数据库迁移（幂等，确保表结构最新）
    await runMigrations();
    logger.info('Database migrations applied successfully');

    // 种子管理员账号
    await seedAdminUser();

    // 加载配置
    await configManager.loadAll();
    logger.info('Configuration loaded successfully');

    // 启动 LISTEN/NOTIFY 监听
    await configManager.startListening();
    logger.info('Database change listener started');

    // 启动内存限流器
    rateLimiter.start();

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
      rateLimiter.stop();
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
  } catch (error) {
    logger.error(error instanceof Error ? error : new Error(String(error)), 'Failed to start server');
    await closePool();
    process.exit(1);
  }
}

void start();

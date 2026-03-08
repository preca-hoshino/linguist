// src/db/client.ts — 数据库连接池与查询客户端

import type { PoolConfig, QueryResult } from 'pg';
import { Pool, Client } from 'pg';
import { createLogger, logColors } from '../utils';

const logger = createLogger('Database', logColors.bold + logColors.magenta);

/**
 * 数据库连接池配置
 * 从环境变量读取连接 URL
 */
function getPoolConfig(): PoolConfig {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  return {
    connectionString: databaseUrl,
    max: parseInt(process.env['DB_POOL_MAX'] ?? '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // 启用 TCP keepalive，防止空闲连接被网络中间设备或数据库静默断开
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // 从池中取出连接时先验证其是否存活，避免使用已断开的连接
    allowExitOnIdle: false,
  };
}

/** PostgreSQL 连接池单例 */
let pool: Pool | null = null;

/**
 * 获取数据库连接池实例（懒初始化单例）
 */
export function getPool(): Pool {
  if (!pool) {
    const config = getPoolConfig();
    pool = new Pool(config);
    logger.info({ maxConnections: config.max }, 'Database pool initialized');

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected database pool error');
    });

    pool.on('connect', () => {
      logger.debug('New database client connected');
    });
  }
  return pool;
}

/**
 * 数据库查询封装
 * 提供简洁的查询接口，自动使用连接池
 */
export const db = {
  /**
   * 执行 SQL 查询
   * @param text SQL 语句（支持 $1, $2 等参数化占位符）
   * @param params 参数值数组
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const maxRetries = 3;
    const retryDelayMs = 500;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const start = Date.now();
        const result = await getPool().query<T>(text, params);
        const duration = Date.now() - start;
        logger.debug({ query: text, duration, rows: result.rowCount }, 'Executed query');
        return result;
      } catch (err) {
        // 连接被断开的错误可以安全重试（查询还未执行）
        const isConnectionError =
          err instanceof Error &&
          (err.message.includes('Connection terminated') ||
            err.message.includes('connection timeout') ||
            err.message.includes('Client has encountered a connection error'));
        if (isConnectionError && attempt < maxRetries) {
          const delay = retryDelayMs * attempt;
          logger.warn({ attempt, maxRetries, delayMs: delay, err }, 'Database connection error, retrying...');
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    // TypeScript: 不可达，但需要满足类型
    throw new Error('Unreachable');
  },
};

/**
 * 创建独立的 pg.Client 用于 LISTEN/NOTIFY
 * 需要独立连接，不能使用连接池（LISTEN 需要持久连接）
 */
export function createListenClient(): Client {
  const config = getPoolConfig();
  logger.debug('Creating LISTEN/NOTIFY client');
  return new Client({
    connectionString: config.connectionString,
  });
}

/**
 * 关闭数据库连接池
 * 用于优雅关闭
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

/**
 * 查询执行器接口
 * db 对象和事务客户端均满足此接口，方便统一调用
 */
export interface QueryExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * 在数据库事务中执行操作
 * 自动处理 BEGIN / COMMIT / ROLLBACK
 *
 * @param fn 接收一个查询执行器，在事务中执行 SQL
 * @returns fn 的返回值
 */
export async function withTransaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

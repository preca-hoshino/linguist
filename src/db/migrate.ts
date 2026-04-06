import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '@/utils';
import { createLogger, logColors } from '@/utils';
import type { QueryExecutor } from './client';
import { closePool, getPool } from './client';

const logger = createLogger('Migration', logColors.bold + logColors.magenta);

/**
 * 执行 migrations/ 目录下的所有 SQL 迁移文件
 * 所有文件均幂等，可安全重跑
 */
async function executeMigrationFiles(executor: QueryExecutor, log: Logger): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .toSorted();

  if (files.length === 0) {
    log.warn('No migration files found.');
    return;
  }

  log.info(`Running ${String(files.length)} migration(s)...`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    try {
      await executor.query(sql);
      log.info(`  ✓ ${file}`);
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)), `✗ ${file} failed`);
      throw error;
    }
  }

  log.info('All migrations completed.');
}

/**
 * 清空数据库所有表（CASCADE）并重新运行迁移
 * 开发专用 ⚠️ — 绝不可在生产环境运行！
 * 用法：npm run db:reset（即 ts-node migrate.ts --reset）
 */
async function resetDatabase(): Promise<void> {
  const pool = getPool();

  logger.warn('═══════════════════════════════════════════════════════════');
  logger.warn('⚠️  WARNING: 此操作将删除数据库中的所有数据！');
  logger.warn('⚠️  仅用于本地开发环境，绝不可在生产环境运行！');
  logger.warn('═══════════════════════════════════════════════════════════');

  logger.warn('🗑️  Dropping all tables (CASCADE)...');
  await pool.query(`
    DO $$
    DECLARE
      tbl text;
    BEGIN
      FOR tbl IN
        SELECT quote_ident(t.tablename)
        FROM pg_tables t
        WHERE t.schemaname = 'public'
      LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || tbl || ' CASCADE';
      END LOOP;
    END $$;
  `);
  logger.info('✓ All tables dropped');

  await executeMigrationFiles(pool, logger);
  logger.info('✅ Database reset completed successfully');
}

/**
 * 运行所有数据库迁移（幂等，可安全在服务启动时调用）
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();
  await executeMigrationFiles(pool, logger);
}

// 直接执行入口（npm run db:migrate 或 npm run db:reset）
if (require.main === module) {
  const isReset = process.argv.includes('--reset');
  const task = isReset ? resetDatabase() : executeMigrationFiles(getPool(), logger);

  task

    .then(async () => {
      await closePool();
    })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error(
        error instanceof Error ? error : new Error(String(error)),
        isReset ? 'Reset failed' : 'Migration failed',
      );
      process.exit(1);
    });
}

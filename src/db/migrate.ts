import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '@/utils';
import { createLogger, logColors } from '@/utils';
import type { QueryExecutor } from './client';
import { closePool, getPool } from './client';

const logger = createLogger('Migration', logColors.bold + logColors.magenta);

/**
 * 按序执行 schema 建表语句和 migrations 历史补丁
 */
async function executeMigrationFiles(executor: QueryExecutor, log: Logger): Promise<void> {
  const schemaDir = path.join(__dirname, 'sql', 'schema');
  const migrationsDir = path.join(__dirname, 'sql', 'migrations');

  // 1. 优先执行 Schema（全量表结构与基础设施定义）
  if (fs.existsSync(schemaDir)) {
    const schemaFiles = fs
      .readdirSync(schemaDir)
      .filter((f) => f.endsWith('.sql'))
      .toSorted();

    if (schemaFiles.length > 0) {
      log.info(`Running ${String(schemaFiles.length)} schema file(s)...`);
      for (const file of schemaFiles) {
        const filePath = path.join(schemaDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        try {
          await executor.query(sql);
          log.info(`  ✓ [Schema] ${file}`);
        } catch (error) {
          log.error(error instanceof Error ? error : new Error(String(error)), `✗ [Schema] ${file} failed`);
          throw error;
        }
      }
    }
  }

  // 2. 执行一次性单向迁移补丁（基于 migration_history 保证单次执行）
  if (fs.existsSync(migrationsDir)) {
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .toSorted();

    if (migrationFiles.length > 0) {
      log.info(`Checking ${String(migrationFiles.length)} migration file(s)...`);

      // 获取当前已在数据库执行过的历史补丁
      const res = await executor.query<{ filename: string }>('SELECT filename FROM migration_history');
      const executedFiles = new Set(res.rows.map((r) => r.filename));

      let newMigrationsCount = 0;
      for (const file of migrationFiles) {
        if (executedFiles.has(file)) {
          continue; // 已执行则安全跳过
        }

        newMigrationsCount++;
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        try {
          await executor.query(sql);
          await executor.query('INSERT INTO migration_history (filename) VALUES ($1)', [file]);
          log.info(`  ✓ [Migration] ${file}`);
        } catch (error) {
          log.error(error instanceof Error ? error : new Error(String(error)), `✗ [Migration] ${file} failed`);
          throw error;
        }
      }

      if (newMigrationsCount === 0) {
        log.info('  ✓ No new migrations to run.');
      }
    }
  }

  log.info('All database synchronizations completed.');
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

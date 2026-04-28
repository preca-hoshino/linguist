import { db } from '@/db/client';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('StatsRefresh', logColors.magenta);

/**
 * 后台定时刷新统计物化视图。
 * 为了高扩展性，未来新增的 mv_stat_mcp_hourly 等视图也可以在这里追加刷新。
 *
 * @param intervalMs 刷新间隔（毫秒），默认 5 分钟
 * @returns 用于停止定时器的 NodeJS.Timeout 对象
 */
export function startStatsRefreshTask(intervalMs: number = 5 * 60 * 1000): NodeJS.Timeout {
  logger.info({}, `Starting statistics materialized views refresh task (interval: ${intervalMs}ms)`);

  const task = async (): Promise<void> => {
    try {
      // 使用 CONCURRENTLY 刷新，不会阻塞前端查询
      await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stat_llm_hourly;');
      logger.debug({}, 'Successfully refreshed mv_stat_llm_hourly');

      // 未来新增：await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stat_mcp_hourly;');
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to refresh statistics materialized views');
    }
  };

  // 初始延迟 10 秒后执行第一次刷新
  setTimeout(() => {
    void task();
  }, 10000);

  // 启动循环定时器
  return setInterval(() => {
    void task();
  }, intervalMs);
}

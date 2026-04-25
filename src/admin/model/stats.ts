// src/admin/stats.ts — 统计分析 API

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { StatsBreakdownGroupBy, StatsDimension, StatsInterval, StatsRange } from '@/db';
import {
  db,
  getStatsBreakdown,
  getStatsErrors,
  getStatsOverview,
  getStatsTimeSeries,
  getStatsToday,
  getStatsTokens,
} from '@/db';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from '../error';

const logger = createLogger('Admin:Stats', logColors.bold + logColors.blue);

const router: Router = Router();

const VALID_RANGES: StatsRange[] = ['15m', '1h', '6h', '24h', '7d', '14d', '30d'];
const VALID_DIMENSIONS: StatsDimension[] = ['global', 'provider', 'provider_model', 'virtual_model', 'app'];
const VALID_INTERVALS: StatsInterval[] = ['1m', '5m', '10m', '15m', '1h', '6h', '1d'];
const VALID_GROUP_BY: StatsBreakdownGroupBy[] = [
  'provider',
  'provider_model',
  'virtual_model',
  'app',
  'error_type',
  'user_format',
];

/**
 * 解析公共查询参数（支持 range 或 from/to 自定义时间范围）
 *
 * 对 provider_model 和 virtual_model 维度做 ID → 名称转换：
 * request_logs 表存储的是字符串名称（routed_model/request_model），不是数据库 ID。
 */
async function parseStatsParams(req: Request): Promise<{
  range?: StatsRange;
  dimension: StatsDimension;
  id: string | undefined;
  from?: string;
  to?: string;
}> {
  // 解析自定义时间范围
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const from = typeof rawFrom === 'string' && rawFrom !== '' ? rawFrom : undefined;
  const to = typeof rawTo === 'string' && rawTo !== '' ? rawTo : undefined;

  if ((from !== undefined && to === undefined) || (from === undefined && to !== undefined)) {
    throw new GatewayError(400, 'invalid_range', "Both 'from' and 'to' must be provided together");
  }

  let range: StatsRange | undefined;
  if (from === undefined && to === undefined) {
    const rawRange = req.query.range;
    const r = (typeof rawRange === 'string' && rawRange !== '' ? rawRange : '1h') as StatsRange;
    if (!VALID_RANGES.includes(r)) {
      throw new GatewayError(400, 'invalid_range', `Invalid range. Valid values: ${VALID_RANGES.join(', ')}`);
    }
    range = r;
  }

  const rawDimension = req.query.dimension;
  const dimension = (
    typeof rawDimension === 'string' && rawDimension !== '' ? rawDimension : 'global'
  ) as StatsDimension;
  if (!VALID_DIMENSIONS.includes(dimension)) {
    throw new GatewayError(400, 'invalid_dimension', `Invalid dimension. Valid values: ${VALID_DIMENSIONS.join(', ')}`);
  }

  const rawId = req.query.id;
  let id = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
  if (dimension !== 'global' && id === undefined) {
    throw new GatewayError(400, 'missing_id', `Parameter 'id' is required when dimension is '${dimension}'`);
  }

  // provider_model: id 是 provider_models.id → 需转换为 provider_models.name (= routed_model)
  if (dimension === 'provider_model' && id !== undefined) {
    const res = await db.query<{ name: string }>('SELECT name FROM model_provider_models WHERE id = $1 LIMIT 1', [id]);
    if (res.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Provider model '${id}' not found`);
    }
    id = res.rows[0]?.name;
  }

  // virtual_model: id 是 virtual_models.id → 需转换为 virtual_models.name (= request_model)
  if (dimension === 'virtual_model' && id !== undefined) {
    const res = await db.query<{ name: string }>('SELECT name FROM virtual_models WHERE id = $1 LIMIT 1', [id]);
    if (res.rowCount === 0) {
      throw new GatewayError(404, 'not_found', `Virtual model '${id}' not found`);
    }
    id = res.rows[0]?.name;
  }

  // app: id 是 apps.id，但在此不需转名称（或者可转），当前可保留 id 查询
  if (dimension === 'app' && id !== undefined) {
    // 若前端传递了 appId，可以直接查询 request_logs_details
    // 假如需要名称转换也可以加在这个逻辑里
  }

  return {
    ...(range === undefined ? {} : { range }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    dimension,
    id,
  };
}

// ==================== GET /admin/stats/overview ====================
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    logger.debug(params, 'Querying stats overview');
    const result = await getStatsOverview(params);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/stats/time-series ====================
router.get('/time-series', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    const rawInterval = req.query.interval;
    const interval = typeof rawInterval === 'string' && rawInterval !== '' ? (rawInterval as StatsInterval) : undefined;
    if (interval !== undefined && !VALID_INTERVALS.includes(interval)) {
      throw new GatewayError(400, 'invalid_interval', `Invalid interval. Valid values: ${VALID_INTERVALS.join(', ')}`);
    }
    logger.debug({ ...params, interval }, 'Querying stats time-series');
    const result = await getStatsTimeSeries(params, interval);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/stats/errors ====================
router.get('/errors', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    logger.debug(params, 'Querying stats errors');
    const result = await getStatsErrors(params);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/stats/tokens ====================
router.get('/tokens', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    logger.debug(params, 'Querying stats tokens');
    const result = await getStatsTokens(params);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/stats/today ====================
router.get('/today', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    logger.debug({ dimension: params.dimension, id: params.id }, 'Querying stats today');
    const result = await getStatsToday(params.dimension, params.id);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/stats/breakdown ====================
router.get('/breakdown', async (req: Request, res: Response) => {
  try {
    const params = await parseStatsParams(req);
    const rawGroupBy = req.query.group_by;
    if (typeof rawGroupBy !== 'string' || rawGroupBy === '') {
      throw new GatewayError(
        400,
        'missing_group_by',
        `Parameter 'group_by' is required. Valid values: ${VALID_GROUP_BY.join(', ')}`,
      );
    }
    const groupBy = rawGroupBy as StatsBreakdownGroupBy;
    if (!VALID_GROUP_BY.includes(groupBy)) {
      throw new GatewayError(400, 'invalid_group_by', `Invalid group_by. Valid values: ${VALID_GROUP_BY.join(', ')}`);
    }
    logger.debug({ ...params, groupBy }, 'Querying stats breakdown');
    const result = await getStatsBreakdown(params, groupBy);
    res.json(result);
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as statsRouter };

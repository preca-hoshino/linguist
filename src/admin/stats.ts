// src/admin/stats.ts — 统计分析 API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { GatewayError, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';
import {
  getStatsOverview,
  getStatsTimeSeries,
  getStatsErrors,
  getStatsTokens,
  getStatsToday,
  getStatsBreakdown,
} from '../db';
import type { StatsDimension, StatsRange, StatsInterval, StatsBreakdownGroupBy } from '../db';

const logger = createLogger('Admin:Stats', logColors.bold + logColors.blue);

const router = Router();

const VALID_RANGES: StatsRange[] = ['15m', '1h', '6h', '24h', '7d', '14d', '30d'];
const VALID_DIMENSIONS: StatsDimension[] = ['global', 'provider', 'provider_model', 'virtual_model', 'api_key'];
const VALID_INTERVALS: StatsInterval[] = ['1m', '5m', '15m', '1h', '6h', '1d'];
const VALID_GROUP_BY: StatsBreakdownGroupBy[] = [
  'provider',
  'provider_model',
  'virtual_model',
  'api_key',
  'error_type',
];

/** 解析公共查询参数（支持 range 或 from/to 自定义时间范围） */
function parseStatsParams(req: Request): {
  range?: StatsRange;
  dimension: StatsDimension;
  id: string | undefined;
  from?: string;
  to?: string;
} {
  // 解析自定义时间范围
  const rawFrom = req.query['from'];
  const rawTo = req.query['to'];
  const from = typeof rawFrom === 'string' && rawFrom !== '' ? rawFrom : undefined;
  const to = typeof rawTo === 'string' && rawTo !== '' ? rawTo : undefined;

  if ((from !== undefined && to === undefined) || (from === undefined && to !== undefined)) {
    throw new GatewayError(400, 'invalid_range', "Both 'from' and 'to' must be provided together");
  }

  let range: StatsRange | undefined;
  if (from === undefined && to === undefined) {
    const rawRange = req.query['range'];
    const r = (typeof rawRange === 'string' && rawRange !== '' ? rawRange : '1h') as StatsRange;
    if (!VALID_RANGES.includes(r)) {
      throw new GatewayError(400, 'invalid_range', `Invalid range. Valid values: ${VALID_RANGES.join(', ')}`);
    }
    range = r;
  }

  const rawDimension = req.query['dimension'];
  const dimension = (
    typeof rawDimension === 'string' && rawDimension !== '' ? rawDimension : 'global'
  ) as StatsDimension;
  if (!VALID_DIMENSIONS.includes(dimension)) {
    throw new GatewayError(400, 'invalid_dimension', `Invalid dimension. Valid values: ${VALID_DIMENSIONS.join(', ')}`);
  }

  const rawId = req.query['id'];
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
  if (dimension !== 'global' && id === undefined) {
    throw new GatewayError(400, 'missing_id', `Parameter 'id' is required when dimension is '${dimension}'`);
  }

  return {
    ...(range !== undefined ? { range } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    dimension,
    id,
  };
}

// ==================== GET /admin/stats/overview ====================
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const params = parseStatsParams(req);
    logger.debug(params, 'Querying stats overview');
    const result = await getStatsOverview(params);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== GET /admin/stats/time-series ====================
router.get('/time-series', async (req: Request, res: Response) => {
  try {
    const params = parseStatsParams(req);
    const rawInterval = req.query['interval'];
    const interval = typeof rawInterval === 'string' && rawInterval !== '' ? (rawInterval as StatsInterval) : undefined;
    if (interval !== undefined && !VALID_INTERVALS.includes(interval)) {
      throw new GatewayError(400, 'invalid_interval', `Invalid interval. Valid values: ${VALID_INTERVALS.join(', ')}`);
    }
    logger.debug({ ...params, interval }, 'Querying stats time-series');
    const result = await getStatsTimeSeries(params, interval);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== GET /admin/stats/errors ====================
router.get('/errors', async (req: Request, res: Response) => {
  try {
    const params = parseStatsParams(req);
    logger.debug(params, 'Querying stats errors');
    const result = await getStatsErrors(params);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== GET /admin/stats/tokens ====================
router.get('/tokens', async (req: Request, res: Response) => {
  try {
    const params = parseStatsParams(req);
    logger.debug(params, 'Querying stats tokens');
    const result = await getStatsTokens(params);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== GET /admin/stats/today ====================
router.get('/today', async (req: Request, res: Response) => {
  try {
    const rawDimension = req.query['dimension'];
    const dimension = (
      typeof rawDimension === 'string' && rawDimension !== '' ? rawDimension : 'global'
    ) as StatsDimension;
    if (!VALID_DIMENSIONS.includes(dimension)) {
      throw new GatewayError(
        400,
        'invalid_dimension',
        `Invalid dimension. Valid values: ${VALID_DIMENSIONS.join(', ')}`,
      );
    }
    const rawId = req.query['id'];
    const id = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
    if (dimension !== 'global' && id === undefined) {
      throw new GatewayError(400, 'missing_id', `Parameter 'id' is required when dimension is '${dimension}'`);
    }
    logger.debug({ dimension, id }, 'Querying stats today');
    const result = await getStatsToday(dimension, id);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== GET /admin/stats/breakdown ====================
router.get('/breakdown', async (req: Request, res: Response) => {
  try {
    const params = parseStatsParams(req);
    const rawGroupBy = req.query['group_by'];
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
  } catch (err) {
    handleError(err, res);
  }
});

export default router;

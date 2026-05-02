// src/admin/mcp-stats.ts — MCP 统计分析 API

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { McpStatsDimension, McpStatsInterval, McpStatsQueryParams, McpStatsRange } from '@/db/mcp-logs';
import {
  getMcpDistribution,
  getMcpMethodBreakdown,
  getMcpStatsErrors,
  getMcpStatsOverview,
  getMcpStatsTimeSeries,
  getMcpStatsToday,
} from '@/db/mcp-logs';
import { GatewayError } from '@/utils';
import { handleAdminError } from '../error';

const router: Router = Router();

const VALID_RANGES: McpStatsRange[] = ['15m', '1h', '6h', '24h', '7d', '14d', '30d'];
const VALID_DIMENSIONS: McpStatsDimension[] = ['global', 'mcp_provider', 'virtual_mcp'];
const VALID_INTERVALS: McpStatsInterval[] = ['1m', '5m', '10m', '15m', '1h', '6h', '1d'];

function parseMcpStatsParams(req: Request): McpStatsQueryParams {
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const from = typeof rawFrom === 'string' && rawFrom !== '' ? rawFrom : undefined;
  const to = typeof rawTo === 'string' && rawTo !== '' ? rawTo : undefined;

  if ((from !== undefined && to === undefined) || (from === undefined && to !== undefined)) {
    throw new GatewayError(400, 'invalid_range', "Both 'from' and 'to' must be provided together").withParam('from');
  }

  let range: McpStatsRange | undefined;
  if (from === undefined && to === undefined) {
    const rawRange = req.query.range;
    const r = (typeof rawRange === 'string' && rawRange !== '' ? rawRange : '1h') as McpStatsRange;
    if (!VALID_RANGES.includes(r)) {
      throw new GatewayError(400, 'invalid_range', `Invalid range. Valid values: ${VALID_RANGES.join(', ')}`).withParam(
        'range',
      );
    }
    range = r;
  }

  const rawDimension = req.query.dimension;
  const dimension = (
    typeof rawDimension === 'string' && rawDimension !== '' ? rawDimension : 'global'
  ) as McpStatsDimension;
  if (!VALID_DIMENSIONS.includes(dimension)) {
    throw new GatewayError(
      400,
      'invalid_dimension',
      `Invalid dimension. Valid values: ${VALID_DIMENSIONS.join(', ')}`,
    ).withParam('dimension');
  }

  const rawId = req.query.id;
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
  if (dimension !== 'global' && id === undefined) {
    throw new GatewayError(400, 'missing_id', `Parameter 'id' is required when dimension is '${dimension}'`).withParam(
      'id',
    );
  }

  return {
    ...(range !== undefined ? { range } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    dimension,
    id,
  };
}

// ==================== GET /admin/mcp-stats/overview ====================
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const params = parseMcpStatsParams(req);
    const result = await getMcpStatsOverview(params);
    res.json({ object: 'stats_overview', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/mcp-stats/time-series ====================
router.get('/time-series', async (req: Request, res: Response) => {
  try {
    const params = parseMcpStatsParams(req);
    const rawInterval = req.query.interval;
    const interval =
      typeof rawInterval === 'string' && rawInterval !== '' ? (rawInterval as McpStatsInterval) : undefined;
    if (interval !== undefined && !VALID_INTERVALS.includes(interval)) {
      throw new GatewayError(
        400,
        'invalid_interval',
        `Invalid interval. Valid values: ${VALID_INTERVALS.join(', ')}`,
      ).withParam('interval');
    }
    const result = await getMcpStatsTimeSeries(params, interval);
    res.json({
      object: 'list',
      url: '/admin/mcp/stats/time-series',
      data: result,
      total: result.length,
      has_more: false,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/mcp-stats/methods ====================
router.get('/methods', async (req: Request, res: Response) => {
  try {
    const params = parseMcpStatsParams(req);
    const result = await getMcpMethodBreakdown(params);
    res.json({ object: 'list', url: '/admin/mcp/stats/methods', data: result, total: result.length, has_more: false });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/mcp-stats/today ====================
router.get('/today', async (_req: Request, res: Response) => {
  try {
    const result = await getMcpStatsToday();
    res.json({ object: 'stats_today', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/mcp-stats/errors ====================
router.get('/errors', async (req: Request, res: Response) => {
  try {
    const params = parseMcpStatsParams(req);
    const result = await getMcpStatsErrors(params);
    res.json({ object: 'stats_errors', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== GET /admin/mcp-stats/distribution ====================
router.get('/distribution', async (req: Request, res: Response) => {
  try {
    const params = parseMcpStatsParams(req);
    const rawGroupBy = req.query.groupBy;
    const groupBy = typeof rawGroupBy === 'string' ? rawGroupBy : '';
    if (groupBy !== 'virtual_mcp' && groupBy !== 'mcp_provider') {
      throw new GatewayError(400, 'invalid_group_by', "groupBy must be 'virtual_mcp' or 'mcp_provider'").withParam(
        'groupBy',
      );
    }
    const result = await getMcpDistribution(params, groupBy);
    res.json({
      object: 'list',
      url: '/admin/mcp/stats/distribution',
      data: result,
      total: result.length,
      has_more: false,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpStatsRouter };

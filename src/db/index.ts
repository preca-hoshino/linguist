// src/db/index.ts — 数据库模块统一出口
export { db, closePool, withTransaction, createListenClient } from './client';
export { generateShortId } from './id-generator';
export type { QueryExecutor } from './client';

export {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  updateApiKey,
  rotateApiKey,
  deleteApiKey,
  validateApiKey,
  loadApiKeyCache,
  invalidateApiKeyCache,
} from './api-keys/index';
export type { ApiKeySummary, ApiKeyCreateResult } from './api-keys/index';

export {
  markProcessing,
  markCompleted,
  markError,
  queryRequestLogs,
  getRequestLogById,
  deleteRequestLogById,
} from './request-logs/index';
export type { RequestLogStatus, RequestLogEntry, RequestLogQuery, ErrorType } from './request-logs/index';

export {
  getStatsOverview,
  getStatsTimeSeries,
  getStatsErrors,
  getStatsTokens,
  getStatsToday,
  getStatsBreakdown,
} from './stats/index';
export type {
  StatsDimension,
  StatsRange,
  StatsInterval,
  StatsQueryParams,
  StatsOverview,
  TimeSeriesPoint,
  TimeSeriesResult,
  StatsErrors,
  StatsTokens,
  StatsToday,
  StatsBreakdownItem,
  StatsBreakdown,
  StatsBreakdownGroupBy,
} from './stats/index';

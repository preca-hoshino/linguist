import type { FilterEntityItem } from "./telemetry";

export type MonitoringDimension = "traffic" | "performance" | "routing" | "cost";
export type TimeRangeKey = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";
export type GranularityKey = "auto" | "minute" | "hour" | "day";

export interface MonitoringMeta {
  range: string;
  granularity: string;
  timezone: string;
  projects: FilterEntityItem[];
  providers: FilterEntityItem[];
  models: FilterEntityItem[];
}

export interface TrafficBucket {
  label: string;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  cacheHitRate: number;
}

export interface UsageSlice {
  id: string;
  name: string;
  totalTokens: number;
  requestCount: number;
}

export interface TrafficMonitoringResponse {
  meta: MonitoringMeta;
  buckets: TrafficBucket[];
  distributionByModel: UsageSlice[];
  distributionByProject: UsageSlice[];
}

export interface PerformanceBucket {
  label: string;
  ttftP50: number;
  ttftP90: number;
  ttftP99: number;
  decodeTpsAvg: number;
  decodeTpsP50: number;
  decodeTpsP90: number;
  avgTtftMs: number;
  avgGenerationMs: number;
  avgTotalDurationMs: number;
  avgE2eTps: number;
}

export interface ModelPerformancePoint {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  avgTtftMs: number;
  avgDecodeTps: number;
  requestCount: number;
  totalTokens: number;
}

export interface PerformanceMonitoringResponse {
  meta: MonitoringMeta;
  buckets: PerformanceBucket[];
  modelQuadrant: ModelPerformancePoint[];
}

export interface RoutingBucket {
  label: string;
  ruleCounts: Record<string, number>;
  firstTrySuccess: number;
  retrySuccess: number;
  finalError: number;
  status2xx: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
}

export interface ProviderRoutingStat {
  providerId: string;
  providerName: string;
  requestCount: number;
  successRate: number;
  errorCount: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface StreamSplit {
  streamCount: number;
  nonStreamCount: number;
}

export interface RoutingMonitoringResponse {
  meta: MonitoringMeta;
  ruleSeriesKeys: string[];
  buckets: RoutingBucket[];
  providerStats: ProviderRoutingStat[];
  finishReasons: NamedCount[];
  streamSplit: StreamSplit;
}

export interface CostSeriesMeta {
  key: string;
  name: string;
}

export interface CostBucket {
  label: string;
  totalAmount: number;
  unpricedCount: number;
  byModel: Record<string, number>;
  inputAmount: number;
  outputAmount: number;
  cacheReadAmount: number;
  cacheWriteAmount: number;
  otherAmount: number;
  costPer1mTokens: number;
  avgCostPerRequest: number;
}

export interface CostRankItem {
  id: string;
  name: string;
  amount: number;
  unpricedCount: number;
  requestCount: number;
}

export interface CostMonitoringResponse {
  meta: MonitoringMeta;
  currency: string | null;
  seriesKeys: CostSeriesMeta[];
  buckets: CostBucket[];
  rankByProject: CostRankItem[];
  rankByModel: CostRankItem[];
}

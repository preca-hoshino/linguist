import type { FilterEntityItem } from "@/features/dashboard/types";

export type MonitoringDimension = "usage" | "performance" | "routing" | "errors" | "cost" | "runtime";
export type TimeRangeKey = "1h" | "6h" | "24h" | "7d" | "30d" | "90d";
export type GranularityKey = "auto" | "minute" | "hour" | "day";
export type StreamModeKey = "all" | "stream" | "non_stream";
export type RuntimeWindowKey = "5m" | "15m" | "1h" | "6h" | "24h";

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
  rpm: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  extraTokensTotal: number;
  cacheHitRate: number;
  avgInputTokens: number;
  p90InputTokens: number;
  avgOutputTokens: number;
  p90OutputTokens: number;
  tpmIn: number;
  tpmOut: number;
  tpmTotal: number;
  rpm032k: number;
  rpm32k128k: number;
  rpm128kPlus: number;
  tpm032k: number;
  tpm32k128k: number;
  tpm128kPlus: number;
}

export interface TrafficSummaryTotals {
  totalRequests: number;
  avgRpm: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  extraTokens: number;
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
  totals: TrafficSummaryTotals;
  buckets: TrafficBucket[];
  distributionByModel: UsageSlice[];
  distributionByProject: UsageSlice[];
  distributionByProvider: UsageSlice[];
  distributionByCallModel: UsageSlice[];
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
  durationP50: number;
  durationP90: number;
  durationP99: number;
  avgE2eTps: number;
  tpotAvg: number;
  tpotP50: number;
  tpotP90: number;
  tpotP99: number;
  avgGatewayOverheadMs: number;
  p50GatewayOverheadMs: number;
  p90GatewayOverheadMs: number;
  p99GatewayOverheadMs: number;
  avgRoutingMs: number;
  avgAttemptPrepMs: number;
  avgUpstreamHeaderMs: number;
}

export interface PerformanceSummary {
  avgGatewayOverheadMs: number;
  ttftP50: number;
  ttftP90: number;
  tpotP50: number;
  decodeTpsAvg: number;
  decodeTpsP50: number;
  durationP50: number;
  durationP90: number;
}

export interface ProviderPerfItem {
  providerId: string;
  providerName: string;
  avgTtftMs: number;
  avgDecodeTps: number;
  avgTpotMs: number;
  requestCount: number;
}

export interface StreamComparisonItem {
  mode: string;
  requestCount: number;
  avgTtftMs: number;
  avgTotalDurationMs: number;
  avgDecodeTps: number;
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

export interface NamedCount {
  name: string;
  count: number;
}

export interface PerformanceMonitoringResponse {
  meta: MonitoringMeta;
  summary: PerformanceSummary;
  buckets: PerformanceBucket[];
  modelQuadrant: ModelPerformancePoint[];
  ttftHistogram: NamedCount[];
  providerBenchmarks: ProviderPerfItem[];
  streamComparison: StreamComparisonItem[];
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

export interface RoutingSummary {
  activeRules: number;
  firstTrySuccessRate: number;
  retrySuccessCount: number;
  retryRecoveryRate: number;
  streamRate: number;
}

export interface RouteRuleStat {
  ruleId: string;
  requestCount: number;
  sharePercent: number;
  endpointCount: number;
  firstTryRate: number;
  fallbackRate: number;
  avgRoutingMs: number;
  avgDurationMs: number;
}

export interface ProviderRoutingStat {
  providerId: string;
  providerName: string;
  requestCount: number;
  successRate: number;
  errorCount: number;
}

export interface StreamSplit {
  streamCount: number;
  nonStreamCount: number;
}

export interface CallModelMappingStat {
  callModelId: string;
  providerId: string;
  modelId: string;
  modelName: string;
  requestCount: number;
}

export interface RoutingMonitoringResponse {
  meta: MonitoringMeta;
  summary: RoutingSummary;
  ruleSeriesKeys: string[];
  buckets: RoutingBucket[];
  ruleStats: RouteRuleStat[];
  providerStats: ProviderRoutingStat[];
  finishReasons: NamedCount[];
  streamSplit: StreamSplit;
  attemptDistribution: NamedCount[];
  callModelMappings: CallModelMappingStat[];
  tokenSources: NamedCount[];
}

export interface ErrorsSummary {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  rateLimitCount: number;
  rateLimitRate: number;
  timeoutOr5xxCount: number;
  timeoutOr5xxRate: number;
  sseInterruptedCount: number;
}

export interface ErrorBucket {
  label: string;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
  status429: number;
  status4xxOther: number;
  status502: number;
  status5xxOther: number;
  avgErrorDurationMs: number;
  retryRecovered: number;
  finalError: number;
}

export interface ErrorDetailRow {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  routeRuleId: string;
  statusCode: number;
  errorSnippet: string;
  count: number;
  sharePercent: number;
  lastSeen: string;
}

export interface ErrorEntityStat {
  id: string;
  name: string;
  totalRequests: number;
  errorCount: number;
  errorRate: number;
}

export interface ErrorsMonitoringResponse {
  meta: MonitoringMeta;
  summary: ErrorsSummary;
  buckets: ErrorBucket[];
  errorDetails: ErrorDetailRow[];
  byProvider: ErrorEntityStat[];
  byModel: ErrorEntityStat[];
  byProject: ErrorEntityStat[];
  statusBreakdown: NamedCount[];
}

export interface CostSeriesMeta {
  key: string;
  name: string;
}

export interface CostBucket {
  label: string;
  totalAmount: number;
  unpricedCount: number;
  scriptErrorCount: number;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
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

export interface CostDetailRow {
  groupBy: string;
  id: string;
  name: string;
  totalAmount: number;
  sharePercent: number;
  inputAmount: number;
  outputAmount: number;
  cacheAmount: number;
  otherAmount: number;
  costPer1mTokens: number;
  requestCount: number;
  unpricedCount: number;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface CostSummary {
  totalAmount: number;
  costPer1mTokens: number;
  avgCostPerRequest: number;
  pricedCount: number;
  unpricedCount: number;
  scriptErrorCount: number;
  coverageRate: number;
  currencyTotals: CurrencyTotal[];
}

export interface CostComponentTotals {
  inputAmount: number;
  outputAmount: number;
  cacheReadAmount: number;
  cacheWriteAmount: number;
  otherAmount: number;
}

export interface CostMonitoringResponse {
  meta: MonitoringMeta;
  currency: string | null;
  summary: CostSummary;
  componentTotals: CostComponentTotals;
  seriesKeys: CostSeriesMeta[];
  projectSeriesKeys: CostSeriesMeta[];
  buckets: CostBucket[];
  rankByProject: CostRankItem[];
  rankByModel: CostRankItem[];
  rankByProvider: CostRankItem[];
  billingStatusCounts: NamedCount[];
  detailRows: CostDetailRow[];
}

export interface RuntimeSample {
  label: string;
  rssMb: number;
  peakRssMb: number;
  cgroupMb: number | null;
  cpuPercent: number;
  openFds: number | null;
  threads: number | null;
  inboundInflight: number;
  activeSseStreams: number;
  outboundInflight: number;
  inboundRps: number;
  inboundProxyRps: number;
  inboundApiRps: number;
  inboundOtherRps: number;
  inbound2xx: number;
  inbound3xx: number;
  inbound4xx: number;
  inbound5xx: number;
  inboundRxBps: number;
  inboundTxBps: number;
  outboundRps: number;
  outbound2xx: number;
  outbound429: number;
  outboundErr: number;
  outboundConnErr: number;
  outboundSseInterrupted: number;
  outboundTxBps: number;
  outboundRxBps: number;
  avgRoutingMs: number;
  avgPrepMs: number;
  pgActive: number;
  pgIdle: number;
  logQueueDepth: number;
  logPersistedRps: number;
  scriptCallsRps: number;
  scriptErrors: number;
  redisHitsRps: number;
  redisMissesRps: number;
  redisWritesRps: number;
  redisErrors: number;
  redisAvgLatencyMs: number;
}

export interface RuntimeSnapshot {
  uptimeSecs: number;
  os: string;
  rssBytes: number;
  peakRssBytes: number;
  virtualBytes: number;
  systemTotalBytes: number;
  systemUsedBytes: number;
  cgroupMemoryBytes: number | null;
  cgroupLimitBytes: number | null;
  cpuPercent: number;
  openFds: number | null;
  threads: number | null;
  inboundInflight: number;
  activeSseStreams: number;
  outboundInflight: number;
  currentInboundRps: number;
  currentOutboundRps: number;
  currentInboundRxBps: number;
  currentInboundTxBps: number;
  currentOutboundTxBps: number;
  currentOutboundRxBps: number;
  pgPoolSize: number;
  pgPoolIdle: number;
  pgPoolMax: number;
  logQueueDepth: number;
  logQueueCapacity: number;
  logEnqueued: number;
  logPersisted: number;
  logRetries: number;
  logDropped: number;
  metricsCacheEndpoints: number;
  metricsCacheSamples: number;
  catalogRevision: number;
  scriptOnRequestCalls: number;
  scriptOnRequestErrors: number;
  scriptOnBillingCalls: number;
  scriptOnBillingErrors: number;
  scriptHttpCalls: number;
  scriptHttpCacheHits: number;
  scriptHttpSingleflight: number;
  scriptHttpSsrfBlocked: number;
  scriptHttpErrors: number;
  scriptHttpCacheEntries: number;
  redisEnabled: boolean;
  redisConnected: boolean;
  redisOpsTotal: number;
  redisHits: number;
  redisMisses: number;
  redisWrites: number;
  redisErrors: number;
  redisLastLatencyMs: number;
  redisHitRate: number;
}

export interface HttpChannelRow {
  key: string;
  label: string;
  direction: "inbound" | "outbound";
  totalRequests: number;
  inflight: number;
  s2xx: number;
  s4xx: number;
  s5xxOrErr: number;
  avgDurationMs: number;
  rxBytes: number;
  txBytes: number;
}

export interface RuntimeMonitoringResponse {
  window: string;
  intervalSecs: number;
  snapshot: RuntimeSnapshot;
  channels: HttpChannelRow[];
  samples: RuntimeSample[];
}

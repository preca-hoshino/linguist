import type {
  CostMonitoringResponse,
  ErrorsMonitoringResponse,
  GranularityKey,
  PerformanceMonitoringResponse,
  RoutingMonitoringResponse,
  RuntimeMonitoringResponse,
  RuntimeWindowKey,
  StreamModeKey,
  TimeRangeKey,
  TrafficMonitoringResponse,
} from "../types/monitoring";

export interface MonitoringQueryParams {
  range: TimeRangeKey;
  granularity: GranularityKey;
  projectId: string;
  providerId: string;
  modelId: string;
  streamMode?: StreamModeKey;
}

function buildMonitoringQuery(params: MonitoringQueryParams): string {
  const search = new URLSearchParams();
  search.set("range", params.range);
  search.set("granularity", params.granularity);
  if (params.projectId) search.set("project_id", params.projectId);
  if (params.providerId) search.set("provider_id", params.providerId);
  if (params.modelId) search.set("model_id", params.modelId);
  if (params.streamMode && params.streamMode !== "all") {
    search.set("stream_mode", params.streamMode);
  }
  return `?${search.toString()}`;
}

async function fetchMonitoringJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} loading ${url}`);
  }
  return (await res.json()) as T;
}

export function fetchTrafficMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<TrafficMonitoringResponse> {
  return fetchMonitoringJson<TrafficMonitoringResponse>(
    `/api/v1/stats/monitoring/traffic${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function fetchPerformanceMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<PerformanceMonitoringResponse> {
  return fetchMonitoringJson<PerformanceMonitoringResponse>(
    `/api/v1/stats/monitoring/performance${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function fetchRoutingMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<RoutingMonitoringResponse> {
  return fetchMonitoringJson<RoutingMonitoringResponse>(
    `/api/v1/stats/monitoring/routing${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function fetchErrorsMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<ErrorsMonitoringResponse> {
  return fetchMonitoringJson<ErrorsMonitoringResponse>(
    `/api/v1/stats/monitoring/errors${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function fetchCostMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<CostMonitoringResponse> {
  return fetchMonitoringJson<CostMonitoringResponse>(
    `/api/v1/stats/monitoring/cost${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function fetchRuntimeMonitoring(
  windowKey: RuntimeWindowKey,
  signal?: AbortSignal,
): Promise<RuntimeMonitoringResponse> {
  return fetchMonitoringJson<RuntimeMonitoringResponse>(
    `/api/v1/stats/monitoring/runtime?window=${encodeURIComponent(windowKey)}`,
    signal,
  );
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatMs(value: number): string {
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value > 0 && value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

export function formatMoney(value: number, currency: string | null): string {
  const prefix = currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency ? `${currency} ` : "$";
  if (value > 0 && value < 0.01) return `${prefix}${value.toFixed(4)}`;
  return `${prefix}${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatBps(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${secs % 60}s`;
}

import type {
  CostMonitoringResponse,
  GranularityKey,
  PerformanceMonitoringResponse,
  RoutingMonitoringResponse,
  TimeRangeKey,
  TrafficMonitoringResponse,
} from "../types/monitoring";

export interface MonitoringQueryParams {
  range: TimeRangeKey;
  granularity: GranularityKey;
  projectId: string;
  providerId: string;
  modelId: string;
}

function buildMonitoringQuery(params: MonitoringQueryParams): string {
  const search = new URLSearchParams();
  search.set("range", params.range);
  search.set("granularity", params.granularity);
  if (params.projectId) search.set("project_id", params.projectId);
  if (params.providerId) search.set("provider_id", params.providerId);
  if (params.modelId) search.set("model_id", params.modelId);
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

export function fetchCostMonitoring(
  params: MonitoringQueryParams,
  signal?: AbortSignal,
): Promise<CostMonitoringResponse> {
  return fetchMonitoringJson<CostMonitoringResponse>(
    `/api/v1/stats/monitoring/cost${buildMonitoringQuery(params)}`,
    signal,
  );
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatMs(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

export function formatMoney(value: number, currency: string | null): string {
  const prefix = currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency ? `${currency} ` : "$";
  if (value > 0 && value < 0.01) return `${prefix}${value.toFixed(4)}`;
  return `${prefix}${value.toFixed(2)}`;
}

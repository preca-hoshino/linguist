import type {
  DailyModelDay,
  LeaderboardItem,
  LeaderboardSort,
  OverviewResponse,
  RecentRequestItem,
} from "../types/telemetry";

const MODEL_PALETTE = [
  "#4B7FFF",
  "#14B8A6",
  "#6366F1",
  "#F59E0B",
  "#EC4899",
  "#0EA5E9",
  "#10B981",
  "#8B5CF6",
  "#EF4444",
  "#06B6D4",
] as const;

export function modelColor(modelKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < modelKey.length; i += 1) {
    hash ^= modelKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % MODEL_PALETTE.length;
  return MODEL_PALETTE[idx] ?? "#4B7FFF";
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toLocaleString("en-US");
}

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} loading ${url}`);
  }
  return (await res.json()) as T;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== "") {
      search.set(key, String(val));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchOverview(
  projectId: string,
  providerId: string,
  days = 365,
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  const qs = buildQuery({
    project_id: projectId,
    provider_id: providerId,
    days,
  });
  return fetchJson<OverviewResponse>(`/api/v1/stats/overview${qs}`, signal);
}

export async function fetchLeaderboard(
  projectId: string,
  providerId: string,
  days: number | undefined,
  sort: LeaderboardSort,
  signal?: AbortSignal,
): Promise<LeaderboardItem[]> {
  const qs = buildQuery({
    project_id: projectId,
    provider_id: providerId,
    days,
    sort,
  });
  return fetchJson<LeaderboardItem[]>(`/api/v1/stats/leaderboard${qs}`, signal);
}

export async function fetchDailyModels(
  projectId: string,
  providerId: string,
  days: number,
  signal?: AbortSignal,
): Promise<DailyModelDay[]> {
  const qs = buildQuery({
    project_id: projectId,
    provider_id: providerId,
    days,
  });
  return fetchJson<DailyModelDay[]>(`/api/v1/stats/daily-models${qs}`, signal);
}

export async function fetchRecentRequests(
  projectId: string,
  providerId: string,
  modelId: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<RecentRequestItem[]> {
  const qs = buildQuery({
    project_id: projectId,
    provider_id: providerId,
    model_id: modelId,
    limit,
  });
  return fetchJson<RecentRequestItem[]>(`/api/v1/stats/recent-requests${qs}`, signal);
}

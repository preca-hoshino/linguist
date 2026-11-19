export interface FilterEntityItem {
  id: string;
  name: string;
  icon: string;
}

export interface TopModelSummary {
  modelId: string;
  modelName: string;
  modelIcon: string;
  totalTokens: number;
}

export interface OverviewSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  totalRequests: number;
  activeStreakDays: number;
  topModel: TopModelSummary | null;
}

export interface ContributionDayCell {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

export interface OverviewResponse {
  title: string;
  timezone: string;
  projects: FilterEntityItem[];
  providers: FilterEntityItem[];
  summary: OverviewSummary;
  days: ContributionDayCell[];
}

export interface LeaderboardItem {
  modelId: string;
  modelName: string;
  modelIcon: string;
  providerId: string;
  providerName: string;
  providerIcon: string;
  avgDecodeTps: number;
  p50DecodeTps: number;
  p90DecodeTps: number;
  avgE2eTps: number;
  avgTtftMs: number;
  requestCount: number;
  totalTokens: number;
}

export interface DailyModelSlice {
  modelId: string;
  modelName: string;
  providerId: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface DailyModelDay {
  date: string;
  models: DailyModelSlice[];
}

export interface RecentRequestItem {
  requestUid: string;
  createdAt: string;
  projectId: string;
  projectName: string;
  callModelId: string;
  callModelName: string;
  providerId: string;
  providerName: string;
  providerIcon: string;
  modelId: string;
  modelName: string;
  modelIcon: string;
  routeRuleId: string;
  attemptIndex: number;
  statusCode: number;
  isStream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  ttftMs: number;
  totalDurationMs: number;
  decodeTps: number;
  e2eTps: number;
}

export type WallMetric = "totalTokens" | "outputTokens" | "requestCount";
export type LeaderboardSort = "avg_decode_tps" | "p50_decode_tps" | "p90_decode_tps" | "avg_ttft_ms";
export type DailyMetric = "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens";

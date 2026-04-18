// src/db/stats/types.ts — 统计分析类型定义
import type { ErrorType } from '@/db/request-logs/types';

/** 聚合维度 */
export type StatsDimension = 'global' | 'provider' | 'provider_model' | 'virtual_model' | 'app';

/** 时间范围字符串 */
export type StatsRange = '15m' | '1h' | '6h' | '24h' | '7d' | '14d' | '30d';

/** 时间粒度 */
export type StatsInterval = '1m' | '5m' | '10m' | '15m' | '1h' | '6h' | '1d';

/** 公共查询参数 */
export interface StatsQueryParams {
  range?: StatsRange;
  dimension: StatsDimension;
  id?: string | undefined;
  /** 自定义时间范围起点（ISO datetime 字符串，与 to 配合使用，优先于 range） */
  from?: string | undefined;
  /** 自定义时间范围终点（ISO datetime 字符串，不含此时刻） */
  to?: string | undefined;
}

/** 概览统计结果 */
export interface StatsOverview {
  total_requests: number;
  rpm: number;
  total_tokens: number;
  tpm: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  error_count: number;
  error_rate: number;
  rate_limit_error_count: number;
  rate_limit_error_rate: number;
  timeout_error_count: number;
  timeout_error_rate: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  avg_provider_latency_ms: number | null;
  gateway_overhead_ms: number | null;
  avg_input_tokens_per_req: number | null;
  avg_output_tokens_per_req: number | null;
  ttft_avg_ms: number | null;
  itl_avg_ms: number | null;
  /** 总费用（后置计费累计） */
  total_cost: number;
}

/** 时序数据点 */
export interface TimeSeriesPoint {
  time: string;
  requests: number;
  rpm: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  tpm: number;
  error_count: number;
  error_rate: number;
  timeout_count: number;
  rate_limit_count: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p90_latency_ms: number | null;
  p99_latency_ms: number | null;
  ttft_avg_ms: number | null;
  ttft_p50_ms: number | null;
  ttft_p90_ms: number | null;
  ttft_p99_ms: number | null;
  itl_avg_ms: number | null;
  itl_p50_ms: number | null;
  itl_p90_ms: number | null;
  itl_p99_ms: number | null;
  cache_hit_rate: number;
  /** 单个 bucket 的费用合计 */
  cost: number;
}

/** 时序查询结果 */
export interface TimeSeriesResult {
  interval: StatsInterval;
  series: TimeSeriesPoint[];
}

/** 错误分析结果 */
export interface StatsErrors {
  total_errors: number;
  error_rate: number;
  by_type: Record<string, number>;
  by_code: Record<string, number>;
  recent_samples: {
    id: string;
    error_type: ErrorType | null;
    error_code: string | null;
    error_message: string | null;
    provider_kind: string | null;
    request_model: string | null;
    created_at: string;
  }[];
}

/** Token 用量分析结果 */
export interface StatsTokens {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  avg_input_tokens_per_req: number | null;
  avg_output_tokens_per_req: number | null;
  p95_input_tokens_per_req: number | null;
  p95_output_tokens_per_req: number | null;
}

/** 今日实时统计（大数字卡片） */
export interface StatsToday {
  today_requests: number;
  today_tokens: number;
  today_prompt_tokens: number;
  today_completion_tokens: number;
  today_errors: number;
  current_rpm: number;
  current_tpm: number;
  current_avg_latency_ms: number | null;
  today_avg_latency_ms: number | null;
  today_avg_ttft_ms: number | null;
  today_avg_itl_ms: number | null;
  current_error_rate: number;
  current_cache_hit_rate: number;
  /** 今日总费用 */
  today_cost: number;
}

/** 分组占比项 */
export interface StatsBreakdownItem {
  name: string;
  /** 提供商名称（仅 provider_model 分组时填充） */
  provider_name: string | null;
  provider_kind?: string | null;
  provider_model_id?: string | null;
  request_count: number;
  total_tokens: number;
  error_count: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p90_latency_ms: number | null;
  p99_latency_ms: number | null;
  /** 平均首 Token 延迟（ms，仅流式请求有值） */
  ttft_avg_ms: number | null;
  /** 平均 ITL（首 Token 之后的生成时间，ms，仅流式请求有值） */
  itl_avg_ms: number | null;
  /** 平均每请求输出 Token 数 */
  avg_completion_tokens: number | null;
  /** 分组总费用 */
  total_cost: number;
}

/** 分组占比查询结果 */
export interface StatsBreakdown {
  group_by: StatsBreakdownGroupBy;
  items: StatsBreakdownItem[];
}

/** 分组占比的分组字段 */
export type StatsBreakdownGroupBy =
  | 'provider'
  | 'provider_model'
  | 'virtual_model'
  | 'app'
  | 'error_type'
  | 'user_format';

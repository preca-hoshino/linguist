export interface PriceTier {
  minInputTokens: number;
  inputPrice: string;
  outputPrice: string;
  cacheReadPrice: string | null;
  cacheWriteMode: "input" | "separate" | "unsupported";
  cacheWritePrice: string | null;
}

export interface PriceSchedule {
  providerId: string;
  modelId: string;
  currency: string;
  source: string;
  maxInputTokens: number | null;
  tiers: PriceTier[];
}

export interface BillingAttempt {
  requestUid: string;
  parentRequestUid: string | null;
  attemptIndex: number;
  createdAt: string;
  projectName: string;
  providerName: string;
  modelName: string;
  modelId: string;
  statusCode: number;
  currency: string | null;
  amount: string | null;
  convertedAmount: string | null;
  billingStatus: string | null;
  details: Record<string, unknown> | null;
}

export interface BillingAttemptGroup {
  requestUid: string;
  items: BillingAttempt[];
  totals: { currency: string; amount: string; count: number }[];
  unpriced: number;
  hasNext: boolean;
}

export interface BillingAmount {
  currency: string;
  amount: string;
}

export interface BillingDashboard {
  today: string;
  totals: BillingAmount[];
  unpriced: number;
  days: { date: string; totals: BillingAmount[]; unpriced: number; wallAmount: string | null }[];
  items: { requestUid: string; currency: string | null; amount: string | null; convertedAmount: string | null; billingStatus: string | null }[];
  displayCurrency: string | null;
  convertedTotal: string | null;
  wallCurrency: string | null;
  wallApproximate: boolean;
}

export class BillingError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function request<T>(path: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/billing/${path}`, {
    ...init,
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "billing_unavailable";
    throw new BillingError(response.status, code);
  }
  return await response.json() as T;
}

export function getPrices(providerId: string, modelId: string, signal: AbortSignal) {
  const query = new URLSearchParams({ provider_id: providerId, model_id: modelId });
  return request<{ item: PriceSchedule | null }>(`prices?${query}`, signal);
}

export function savePrice(price: PriceSchedule, csrfToken: string, signal: AbortSignal) {
  return request<{ item: PriceSchedule }>("prices", signal, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(price),
  });
}

export function getReferenceRate(currency: string, signal: AbortSignal) {
  return request<{ target: string | null; rate: string | null; date: string | null }>(`fx?${new URLSearchParams({ currency })}`, signal);
}

export function getBillingAttempts(requestUid: string, page: number, signal: AbortSignal) {
  const query = new URLSearchParams({ request_uid: requestUid, page: String(page) });
  return statsRequest<BillingAttemptGroup>(`attempts?${query}`, signal);
}

export function getBillingDashboard(projectId: string, providerId: string, requestUids: string[], signal: AbortSignal) {
  return statsRequest<BillingDashboard>("", signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: projectId || null, providerId: providerId || null, requestUids }),
  });
}

async function statsRequest<T>(path: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/stats/billing${path ? `/${path}` : ""}`, {
    ...init,
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error("billing_unavailable");
  return await response.json() as T;
}

const statusLabels: Record<string, string> = {
  estimated: "估算", missing_price: "未配置价格", missing_usage: "缺少用量", invalid_usage: "用量异常",
  unsupported_price: "不支持计价", target_changed: "上游地址或模型已改写",
  pricing_error: "计价失败", invalid_price: "价格无效",
};

export function billingStatus(status: string | null): string {
  return statusLabels[status ?? ""] ?? "未记录费用";
}

export function money(amount: string | null, currency: string | null): string {
  if (amount === null || currency === null) return "—";
  return `${currency} ${amount.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

export function billingError(error: unknown): string {
  const code = error instanceof Error ? error.message : "billing_unavailable";
  const messages: Record<string, string> = {
    unauthorized: "登录已失效，请重新登录",
    catalog_disabled: "目录服务不可用",
    invalid_price: "价格无效",
    model_not_found: "模型不存在",
    invalid_query: "筛选条件无效",
  };
  return messages[code] ?? "费用数据加载失败";
}

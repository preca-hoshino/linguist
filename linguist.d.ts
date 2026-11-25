export interface EntityInfo {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly tags: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface ProviderInfo extends EntityInfo {
  /** Only populated in stage ④ Model / ⑤ Provider / onBilling; scrubbed from persisted logs. */
  readonly apiKey: string;
}

export interface RouteEndpoint {
  providerId: string;
  modelId: string;
  /** Total attempts for this endpoint, including the first (1-5; default: 1). */
  maxAttempts?: number;
}

export interface CandidateItem {
  readonly provider: EntityInfo;
  readonly model: EntityInfo;
  readonly metrics: {
    readonly avgDecodeTps?: number;
    readonly p50DecodeTps?: number;
    readonly avgTtftMs?: number;
    readonly errorRate?: number;
  };
}

export interface ScriptContext {
  readonly stage: "project" | "callModel" | "route" | "model" | "provider";
  readonly project: EntityInfo;
  readonly callModel: EntityInfo;
  readonly routeInfo: EntityInfo | null;
  readonly provider: ProviderInfo | null;
  readonly model: EntityInfo | null;

  route: {
    readonly ruleId: string | null;
    candidates: CandidateItem[];
    target: RouteEndpoint | null;
    fallbacks: RouteEndpoint[];
    continue?: boolean;
    rewriteResponseModel: boolean;
  };

  request: {
    readonly uid: string;
    readonly attempt: number;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    injectStreamOptions: boolean;
    timeoutSecs?: number;
    retryStatusCodes?: number[];
    readonly signals: {
      readonly isStream: boolean;
      readonly hasVisionImages: boolean;
      readonly hasTools: boolean;
      readonly messageCount: number;
      readonly estimatedInputChars: number;
    };
  };

  state: Record<string, unknown>;
  reject: { statusCode: number; message: string } | null;
}

export type CostItemKind = "input" | "output" | "cache_read" | "cache_write" | "other";

export interface BillingDraft {
  setCurrency(currency: string): void;
  setStatus(status: "priced" | "estimated" | "free" | "unpriced"): void;
  addItem(item: {
    label: string;
    amount: string | number;
    kind?: CostItemKind;
    quantity?: string;
    unitPrice?: string;
  }): void;
  addInput(label: string, amount: string | number, quantity?: string, unitPrice?: string): void;
  addOutput(label: string, amount: string | number, quantity?: string, unitPrice?: string): void;
  addCacheRead(label: string, amount: string | number, quantity?: string, unitPrice?: string): void;
  addCacheWrite(label: string, amount: string | number, quantity?: string, unitPrice?: string): void;
  addOther(label: string, amount: string | number, quantity?: string, unitPrice?: string): void;
  setTotal(currency: string, amount: string | number, label?: string): void;
  reset(): void;
  freeze(): void;
  setMeta(key: string, value: unknown): void;
  overrideUsage(patch: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    extraTokens?: Record<string, number>;
  }): void;
}

export interface BillingContext {
  readonly requestStartedAtUtc: string;
  readonly completedAtUtc: string;
  readonly attempt: number;
  readonly statusCode: number;
  readonly isStream: boolean;
  readonly interrupted: boolean;
  readonly project: EntityInfo;
  readonly callModel: EntityInfo;
  readonly provider: ProviderInfo;
  readonly model: EntityInfo;
  readonly state: Readonly<Record<string, unknown>>;
  readonly timings: {
    readonly ttftMs: number;
    readonly totalDurationMs: number;
    readonly generationDurationMs: number;
    readonly decodeTps: number;
  };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
    readonly reasoning: number;
    readonly total: number;
    readonly extra: Readonly<Record<string, number>>;
    readonly source: "upstream_usage" | "fallback_estimated";
  };
  readonly rawUsage: Readonly<Record<string, unknown>> | null;
  readonly draft: BillingDraft;
}

export interface StandardPriceTier {
  minInputTokens: number;
  inputPrice: string;
  outputPrice: string;
  cacheReadPrice?: string | null;
  cacheWriteMode: "input" | "separate" | "unsupported";
  cacheWritePrice?: string | null;
}

export interface StandardPricingSpec {
  currency: string;
  source?: string;
  maxInputTokens?: number | null;
  tiers: StandardPriceTier[];
}

export interface HttpFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
  cacheKey?: string;
  cacheTtlSecs?: number;
}

declare const linguist: {
  costPerMillion(tokens: number, ratePerMillion: string | number): string;
  decAdd(...values: Array<string | number>): string;
  decSub(a: string | number, b: string | number): string;
  decMul(a: string | number, b: string | number): string;
  tierBilling(ctx: BillingContext, spec: StandardPricingSpec): void;
  http: {
    fetchJson<T = unknown>(url: string, options?: HttpFetchOptions): Promise<T>;
    fetchText(url: string, options?: HttpFetchOptions): Promise<{ status: number; body: string }>;
  };
};

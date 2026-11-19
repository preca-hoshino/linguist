export default function handle(ctx: ScriptContext): ScriptContext | void;

export interface ScriptContext {
  /** 1. 当前执行阶段（只读，统一 camelCase） */
  readonly stage: "project" | "callModel" | "route" | "model" | "provider";

  /** 2. 消费侧项目（1:1 映射 projects.json[]，已脱敏 apiKey 与 script） */
  readonly project: ProjectMeta;

  /** 3. 消费侧调用模型（1:1 映射 projects.json[].callModels[]） */
  readonly callModel: CallModelMeta;

  /** 4. 供给侧提供商（1:1 映射 chatLanguageModels.json[]；③ 选路前为 null，④⑤ 填充） */
  readonly provider: ProviderMeta | null;

  /** 5. 供给侧模型（1:1 映射 chatLanguageModels.json[].models[] 原字段，零重命名；③ 前为 null） */
  readonly model: ModelMeta | null;

  /** 6. 路由控制状态（1:1 映射 routes.json 字段） */
  route: {
    readonly ruleId: string;
    candidates: CandidateItem[];
    target: RouteEndpoint | null;
    fallbacks: RouteEndpoint[];
    rewriteResponseModel: boolean;
  };

  /** 7. 出站 HTTP 请求（全 5 层均可直接修改 url / headers / body） */
  request: {
    readonly uid: string;
    readonly attempt: number;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    readonly signals: {
      isStream: boolean;
      hasVisionImages: boolean;
      hasTools: boolean;
      messageCount: number;
      estimatedInputChars: number;
    };
  };

  /** 8. 跨 ① -> ⑤ 自由传递的状态袋 */
  state: Record<string, unknown>;

  /** 9. 中断控制（任一层置非 null 即立刻中止请求并响应 HTTP 错误） */
  reject: { statusCode: number; message: string } | null;
}

export interface ProjectMeta {
  id: string;
  name: string;
  icon?: string;
  meta: Record<string, unknown>;
}

export interface CallModelMeta {
  id: string;
  name: string;
  icon?: string;
  meta: Record<string, unknown>;
}

export interface ProviderMeta {
  id: string;
  name: string;
  icon?: string;
}

export interface ModelMeta {
  id: string;
  name: string;
  icon?: string;
  url: string;
  supportsReasoningEffort?: string[];
  toolCalling?: boolean;
  vision?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface RouteEndpoint {
  providerId: string;
  modelId: string;
}

export interface CandidateItem {
  provider: ProviderMeta;
  model: ModelMeta;
  metrics: {
    avgDecodeTps?: number;
    p50DecodeTps?: number;
    avgTtftMs?: number;
    errorRate?: number;
  };
}

// src/types/config.ts — 配置与路由相关类型定义

export type ModelType = 'chat' | 'embedding' | 'rerank' | 'image' | 'audio';

// ==================== 凭证系统（判别联合） ====================

/** API Key 认证方式 */
export interface ApiKeyCredential {
  type: 'api_key';
  key: string;
}

/** OAuth2 认证方式（预留） */
export interface OAuth2Credential {
  type: 'oauth2';
  accessToken: string;
  refreshToken: string;
  /** ISO 8601 过期时间 */
  expiresAt: string;
  tokenEndpoint: string;
}

/** 无认证（如本地模型） */
export interface NoCredential {
  type: 'none';
}

/** GitHub Copilot 认证方式（OAuth Device Flow） */
export interface CopilotCredential {
  type: 'copilot';
  /** GitHub OAuth access_token (ghu_xxx)，长效，由 Device Flow 换取 */
  accessToken: string;
}

/** 提供商凭证（判别联合） */
export type ProviderCredential = ApiKeyCredential | OAuth2Credential | CopilotCredential | NoCredential;

// ==================== 高级配置 ====================

/** 提供商高级配置（存储在 config JSONB 列） */
export interface ProviderAdvancedConfig {
  /** 自定义请求头（有则覆盖，无则新加） */
  custom_headers: Record<string, string>;
  /** HTTP 代理地址（空字符串表示不使用） */
  http_proxy: string;
  /** 提供商特有的扩展配置 */
  [key: string]: unknown;
}

/** 高级配置默认值 */
export const DEFAULT_PROVIDER_CONFIG: ProviderAdvancedConfig = {
  custom_headers: {},
  http_proxy: '',
};

// ==================== 提供商配置 ====================

/**
 * 提供商配置（从 providers 表加载到内存）
 */
export interface ProviderConfig {
  id: string;
  /** 协议类型标识: 'deepseek', 'gemini', 'volcengine' 等 */
  kind: string;
  /** 提供商显示名称 */
  name: string;
  /** 凭证对象（判别联合） */
  credential: ProviderCredential;
  /** API 基地址 */
  baseUrl: string;
  /** 高级配置 */
  config: ProviderAdvancedConfig;
}

// ==================== 虚拟模型配置 ====================

/**
 * 虚拟模型后端（一个虚拟模型可关联多个后端）
 */
export interface VirtualModelBackend {
  /** 提供商模型 ID */
  providerModelId: string;
  /** 提供商侧真实模型名 */
  actualModel: string;
  /** 模型类型 */
  modelType: ModelType;
  /** 模型能力标识列表 (chat: vision/tools/thinking/web_search; embedding: multimodal/sparse_vector) */
  capabilities: string[];
  /** 支持的可调优参数列表 */
  supportedParameters: string[];
  /** 权重（用于 load_balance） */
  weight: number;
  /** 优先级（用于 failover，数值越小优先级越高） */
  priority: number;
  /** 关联的提供商配置 */
  provider: ProviderConfig;
  /** 每分钟请求数上限（undefined = 不限制） */
  rpmLimit?: number | undefined;
  /** 每分钟 Token 数上限（undefined = 不限制） */
  tpmLimit?: number | undefined;
  /** 提供商模型级专属配置（来自 provider_models.model_config，各提供商插件按需读取） */
  modelConfig?: Record<string, unknown> | undefined;
}

/**
 * 虚拟模型配置（从 virtual_models + backends 联表加载）
 */
export interface VirtualModelConfig {
  /** 虚拟模型 ID（用户请求的 model 字段） */
  id: string;
  /** 模型类型（与关联的提供商模型保持一致） */
  modelType: ModelType;
  /** 路由策略 */
  routingStrategy: 'load_balance' | 'failover';
  /** 后端列表 */
  backends: VirtualModelBackend[];
  /** 每分钟请求数上限（undefined = 不限制） */
  rpmLimit?: number | undefined;
  /** 每分钟 Token 数上限（undefined = 不限制） */
  tpmLimit?: number | undefined;
  /** 模型首创时间 */
  createdAt: Date;
}

// ==================== 路由解析结果 ====================

/**
 * 路由解析结果（从虚拟模型选出的具体后端）
 */
export interface ResolvedRoute {
  /** 提供商侧的实际模型 ID */
  actualModel: string;
  /** 模型类型 */
  modelType: ModelType;
  /** 模型能力标识列表 */
  capabilities: string[];
  /** 支持的可调优参数列表 */
  supportedParameters: string[];
  /** 提供商协议类型 */
  providerKind: string;
  /** 提供商 ID */
  providerId: string;
  /** 关联的提供商配置 */
  provider: ProviderConfig;
  /** 路由策略 */
  routingStrategy: 'load_balance' | 'failover';
}

// src/types/config.ts — 配置与路由相关类型定义

// ==================== 提供商配置 ====================

/**
 * 提供商配置（从 providers 表加载）
 */
export interface ProviderConfig {
  id: string;
  /** 协议类型标识: 'openai', 'claude', 'gemini', 'deepseek', 'dashscope', 'openrouter' */
  kind: string;
  /** 提供商显示名称 */
  name: string;
  /** API 密钥 */
  apiKey: string;
  /** API 基地址 */
  baseUrl: string;
  /** 额外配置 */
  config: Record<string, unknown>;
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
  modelType: 'chat' | 'embedding';
  /** 模型能力标识列表 (chat: vision/tools/thinking/web_search; embedding: multimodal/sparse_vector) */
  capabilities: string[];
  /** 权重（用于 load_balance） */
  weight: number;
  /** 优先级（用于 failover，数值越小优先级越高） */
  priority: number;
  /** 关联的提供商配置 */
  provider: ProviderConfig;
}

/**
 * 虚拟模型配置（从 virtual_models + backends 联表加载）
 */
export interface VirtualModelConfig {
  /** 虚拟模型 ID（用户请求的 model 字段） */
  id: string;
  /** 模型类型（与关联的提供商模型保持一致） */
  modelType: 'chat' | 'embedding';
  /** 路由策略 */
  routingStrategy: 'load_balance' | 'failover';
  /** 后端列表 */
  backends: VirtualModelBackend[];
}

// ==================== 路由解析结果 ====================

/**
 * 路由解析结果（从虚拟模型选出的具体后端）
 */
export interface ResolvedRoute {
  /** 提供商侧的实际模型 ID */
  actualModel: string;
  /** 模型类型 */
  modelType: 'chat' | 'embedding';
  /** 模型能力标识列表 */
  capabilities: string[];
  /** 提供商协议类型 */
  providerKind: string;
  /** 提供商 ID */
  providerId: string;
  /** 关联的提供商配置 */
  provider: ProviderConfig;
  /** 路由策略 */
  routingStrategy: 'load_balance' | 'failover';
}

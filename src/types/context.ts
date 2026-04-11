// src/types/context.ts — 网关上下文类型定义

import type { InternalChatRequest, InternalChatResponse } from './chat';
import type { ProviderConfig } from './config';
import type { InternalEmbeddingRequest, InternalEmbeddingResponse } from './embedding';
import type { HttpHeaders, ProviderErrorDetail } from './provider';

/**
 * 全局上下文对象 (Gateway Context)
 * 贯穿请求全生命周期的唯一载体，携带元数据、请求/响应载荷及执行状态。
 * 所有模块（适配器、中间件、路由、核心编排）均通过此对象进行数据传递。
 */
export interface ModelHttpContext {
  // --- 基础元数据 ---

  /** 网关生成的唯一请求 ID */
  id: string;

  /** 客户端 IP 地址 */
  ip: string;

  // --- 认证 ---

  /** 原始传入的 API Key (通常在日志中需脱敏) */
  apiKey?: string | undefined;

  /** API Key 前缀（前11位，脱敏后用于审计溯源） */
  apiKeyPrefix?: string | undefined;

  /** API Key 分配的名称（若存在） */
  apiKeyName?: string | undefined;

  /** 所属应用 ID */
  appId?: string | undefined;

  /** 所属应用名称 */
  appName?: string | undefined;

  // --- HTTP 入站元数据 ---

  /** HTTP 请求元信息（入站侧 method / path / UA） */
  http: {
    /** HTTP 请求方法（大写，如 'POST'） */
    method: string;
    /** 请求路径（如 '/v1/chat/completions'） */
    path: string;
    /** 客户端 User-Agent */
    userAgent?: string | undefined;
  };

  // --- 用户 API 格式 ---

  /** 用户 API 格式 (如 'openai', 'gemini') */
  userFormat: string;

  // --- 模型请求 ---

  /** 用户请求的原始虚拟模型名称 (e.g., "gpt-4") */
  requestModel: string;

  // --- 路由解析结果 ---

  /**
   * 路由解析后的完整上下文（由路由模块一次性填充）
   * undefined 表示路由尚未完成；failover 重试时会更新为新候选后端
   */
  route?: {
    /** 提供商侧的实际模型 ID（如 "deepseek-chat"） */
    model: string;
    /** 模型类型 */
    modelType: 'chat' | 'embedding';
    /** 提供商协议类型（如 "openai", "gemini", "deepseek"） */
    providerKind: string;
    /** 提供商配置 ID — UUID */
    providerId: string;
    /** 提供商完整配置（避免二次查找） */
    providerConfig: ProviderConfig;
    /** 路由策略 */
    strategy: 'load_balance' | 'failover';
    /** 请求所需的能力标识 */
    capabilities: string[];
  };

  // --- 核心载荷 (Payload) ---

  /**
   * 标准化请求对象 (Internal Request)
   * 经过 UserAdapter 转换后的内部统一格式
   */
  request?: InternalChatRequest | InternalEmbeddingRequest | undefined;

  /**
   * 标准化响应对象 (Internal Response)
   * 经过 ProviderAdapter 转换后的内部统一格式
   * 流式响应在传输完毕后由 mergeStreamChunks 合并为等价的完整响应
   */
  response?: InternalChatResponse | InternalEmbeddingResponse | undefined;

  /** 是否为流式请求（仅 chat 有效） */
  stream?: boolean | undefined;

  // --- 审计原始数据（四次交换） ---

  /**
   * 审计数据：记录完整生命周期中的 4 次 HTTP 交换
   * 每次交换包含请求头 + 请求体（或响应头 + 响应体）
   *
   * 1. userRequest    — 用户 → 网关（入站原始请求）
   * 2. providerRequest — 网关 → 提供商（转发请求）
   * 3. providerResponse— 提供商 → 网关（上游响应）
   * 4. userResponse   — 网关 → 用户（最终响应）
   */
  audit: {
    /** 用户 → 网关：入站原始请求（包含脱敏后的请求头） */
    userRequest?: {
      headers?: HttpHeaders;
      body?: Record<string, unknown>;
    };
    /** 网关 → 提供商：转发请求（caller 填充） */
    providerRequest?: {
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    };
    /** 提供商 → 网关：上游响应（caller 填充） */
    providerResponse?: {
      headers?: Record<string, string>;
      body?: unknown;
    };
    /** 网关 → 用户：最终响应（包含实际发送的响应头） */
    userResponse?: {
      headers?: HttpHeaders;
      body?: unknown;
    };
  };

  // --- 扩展信息 ---

  /** 执行过程中的错误信息 */
  error?: string | undefined;

  /** 提供商原始错误详情（仅提供商来源的错误携带，用于审计和 UI 展示） */
  providerError?: ProviderErrorDetail | undefined;

  /**
   * 性能计时 (Unix 毫秒时间戳，即 Date.now())
   * 记录关键阶段的绝对时间戳，用于监控、日志和审计
   * timing.start 同时作为请求接收时间（替代旧 timestamp 字段，需要 Unix 秒时用 Math.floor(timing.start / 1000)）
   */
  timing: {
    /** 请求到达网关的时间 */
    start: number;

    // --- 入站阶段 ---
    /** 用户请求适配完成时间 */
    requestAdapted?: number | undefined;
    /** 请求中间件链执行完成时间 */
    middlewareDone?: number | undefined;
    /** 路由解析完成时间 */
    routed?: number | undefined;

    // --- 提供商阶段 ---
    /** 向供应商发起请求的时间 */
    providerStart?: number | undefined;
    /** 首 Token 到达时间（流式场景） */
    ttft?: number | undefined;
    /** 供应商响应接收完成时间 */
    providerEnd?: number | undefined;

    // --- 出站阶段 ---
    /** 响应中间件链执行完成时间 */
    responseMiddlewareDone?: number | undefined;
    /** 用户响应适配完成时间 */
    responseAdapted?: number | undefined;

    /** 完整流程结束时间 */
    end?: number | undefined;
  };
}

/**
 * 路由解析完成后的上下文类型（route 字段已填充）
 * 使用 assertRouted() 类型守卫后可直接访问 ctx.route 的所有字段而无需 undefined 检查
 */
export type RoutedModelHttpContext = ModelHttpContext & {
  route: {
    model: string;
    modelType: 'chat' | 'embedding';
    providerKind: string;
    providerId: string;
    providerConfig: ProviderConfig;
    strategy: 'load_balance' | 'failover';
    capabilities: string[];
  };
};

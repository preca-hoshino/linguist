// src/providers/copilot/token-manager.ts — Copilot 短效 Token 获取与缓存管理

import { createLogger, GatewayError, logColors } from '@/utils';
import {
  COPILOT_EDITOR_HEADERS,
  COPILOT_MODELS_CACHE_TTL_MS,
  COPILOT_TOKEN_URL,
  TOKEN_REFRESH_MARGIN_SECONDS,
} from './constants';
import { resolveEndpointType } from './chat/fallback/endpoint-resolver';
import type { CopilotEndpointType } from './chat/fallback/types';

const logger = createLogger('Provider:Copilot:Token', logColors.bold + logColors.cyan);

/**
 * Copilot 短效 Token 信息
 * 通过 access_token 从 GitHub API 换取，有效期约 30 分钟
 */
interface CopilotTokenInfo {
  /** Copilot API 认证 Token（用于 Bearer Authorization） */
  token: string;
  /** 过期时间戳（Unix epoch seconds） */
  expiresAt: number;
  /** API 基地址（从响应 endpoints.api 字段解析，个人版/企业版地址不同） */
  apiEndpoint: string;
}

/** GitHub Copilot Token API 响应结构 */
interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  endpoints: {
    api: string;
  };
}

/** Copilot GET /models 单条模型信息（仅提取关注字段） */
interface CopilotModelInfo {
  id: string;
  supported_endpoints?: string[];
}

/** Copilot GET /models 响应结构 */
interface CopilotModelsResponse {
  data: CopilotModelInfo[];
}

/** 模型列表缓存条目 */
interface ModelsCacheEntry {
  models: CopilotModelInfo[];
  /** 缓存写入时间（Date.now() 毫秒） */
  fetchedAt: number;
}

/**
 * Copilot Token 管理器
 *
 * 职责：
 * - 使用长效 access_token 换取短效 Copilot Token（约 30 分钟有效期）
 * - 按 providerId 隔离缓存，支持多个 Copilot 提供商实例并存
 * - 在 Token 过期前 TOKEN_REFRESH_MARGIN_SECONDS 秒自动刷新
 * - 防止同一 Provider 的并发刷新请求（使用 pending Map）
 * - 缓存 GET /models 结果（TTL 1小时），用于端点类型自动探测
 */
export class CopilotTokenManager {
  /** providerId → CopilotTokenInfo */
  private readonly cache = new Map<string, CopilotTokenInfo>();
  /** providerId → 正在进行的刷新 Promise（防止并发请求） */
  private readonly pending = new Map<string, Promise<CopilotTokenInfo>>();
  /** providerId → 模型列表缓存（TTL 1小时） */
  private readonly modelCache = new Map<string, ModelsCacheEntry>();

  /**
   * 获取有效的 Copilot Token（缓存命中时直接返回，否则自动刷新）
   *
   * @param providerId - 提供商 ID（用于隔离缓存）
   * @param accessToken - GitHub OAuth access_token (ghu_xxx)
   */
  public async getToken(providerId: string, accessToken: string): Promise<CopilotTokenInfo> {
    const cached = this.cache.get(providerId);
    const now = Math.floor(Date.now() / 1000);

    // 缓存有效：距过期超过 TOKEN_REFRESH_MARGIN_SECONDS
    if (cached !== undefined && now + TOKEN_REFRESH_MARGIN_SECONDS < cached.expiresAt) {
      logger.debug({ providerId, expiresAt: cached.expiresAt }, 'Copilot token cache hit');
      return await Promise.resolve(cached);
    }

    // 已有正在进行的刷新，等待其完成
    const pendingRefresh = this.pending.get(providerId);
    if (pendingRefresh !== undefined) {
      logger.debug({ providerId }, 'Waiting for pending Copilot token refresh');
      return await pendingRefresh;
    }

    // 发起新的刷新请求
    logger.debug({ providerId }, 'Fetching new Copilot token');
    const refreshPromise = this.fetchCopilotToken(accessToken)
      .then((tokenInfo) => {
        this.cache.set(providerId, tokenInfo);
        this.pending.delete(providerId);
        logger.info(
          { providerId, expiresAt: tokenInfo.expiresAt, apiEndpoint: tokenInfo.apiEndpoint },
          'Copilot token refreshed',
        );
        return tokenInfo;
      })
      .catch((err: unknown) => {
        this.pending.delete(providerId);
        throw err;
      });

    this.pending.set(providerId, refreshPromise);
    return await refreshPromise;
  }

  /**
   * 获取指定模型应使用的端点类型
   *
   * 流程：
   * 1. 从缓存中查找模型列表（TTL 1小时）
   * 2. 缓存未命中 → 使用已有 token 调用 GET /models → 缓存结果
   * 3. 委托 endpoint-resolver 解析 supported_endpoints → CopilotEndpointType
   * 4. 查询失败时静默回退 'chat-completions'（故障安全：避免短暂的 GET /models 失败阻断请求）
   *
   * @param providerId - 提供商 ID（用于隔离模型缓存）
   * @param accessToken - 已获取的短效 Copilot Token
   * @param apiEndpoint - API 基地址（来自 resolveToken）
   * @param modelId - 需要查询的模型 ID
   */
  public async getEndpointType(
    providerId: string,
    accessToken: string,
    apiEndpoint: string,
    modelId: string,
  ): Promise<CopilotEndpointType> {
    try {
      const models = await this.getModels(providerId, accessToken, apiEndpoint);
      const modelInfo = models.find((m) => m.id === modelId);
      const endpointType = resolveEndpointType(modelInfo?.supported_endpoints);
      logger.debug(
        { providerId, modelId, endpointType, supported: modelInfo?.supported_endpoints },
        'Resolved endpoint type',
      );
      return endpointType;
    } catch (err: unknown) {
      logger.warn({ providerId, modelId, err }, 'Failed to resolve endpoint type, falling back to chat-completions');
      return 'chat-completions';
    }
  }

  /**
   * 清除指定 Provider 的 Token 缓存（强制下次重新获取）
   */
  public invalidate(providerId: string): void {
    this.cache.delete(providerId);
    logger.debug({ providerId }, 'Copilot token cache invalidated');
  }

  /**
   * 从 GitHub API 获取新的 Copilot Token
   */
  private async fetchCopilotToken(accessToken: string): Promise<CopilotTokenInfo> {
    const response = await fetch(COPILOT_TOKEN_URL, {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        'Content-Type': 'application/json',
        ...COPILOT_EDITOR_HEADERS,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error({ status: response.status, body }, 'Failed to fetch Copilot token');
      throw new GatewayError(
        response.status === 401 ? 401 : 502,
        response.status === 401 ? 'authentication_error' : 'provider_error',
        `Failed to fetch Copilot token: HTTP ${String(response.status)}`,
      );
    }

    const data = (await response.json()) as CopilotTokenResponse;

    if (!data.token || !data.expires_at || !data.endpoints.api) {
      throw new GatewayError(502, 'provider_response_invalid', 'Copilot token response missing required fields');
    }

    return {
      token: data.token,
      expiresAt: data.expires_at,
      apiEndpoint: data.endpoints.api,
    };
  }

  /**
   * 获取模型列表（带 TTL 缓存）
   * 优先从缓存读取，缓存失效时发起 GET /models 请求
   */
  private async getModels(providerId: string, accessToken: string, apiEndpoint: string): Promise<CopilotModelInfo[]> {
    const cached = this.modelCache.get(providerId);
    const now = Date.now();

    if (cached !== undefined && now - cached.fetchedAt < COPILOT_MODELS_CACHE_TTL_MS) {
      logger.debug({ providerId }, 'Copilot models cache hit');
      return cached.models;
    }

    logger.debug({ providerId }, 'Fetching Copilot models list');
    const models = await this.fetchModels(accessToken, apiEndpoint);
    this.modelCache.set(providerId, { models, fetchedAt: now });
    logger.info({ providerId, count: models.length }, 'Copilot models list cached');
    return models;
  }

  /**
   * 调用 Copilot GET /models 获取模型列表
   * 失败时抛出异常（由 getEndpointType 捕获并回退）
   */
  private async fetchModels(accessToken: string, apiEndpoint: string): Promise<CopilotModelInfo[]> {
    const url = `${apiEndpoint}/models`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...COPILOT_EDITOR_HEADERS,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      logger.warn({ status: response.status, body }, 'Copilot GET /models failed');
      throw new GatewayError(502, 'provider_error', `Copilot GET /models returned HTTP ${String(response.status)}`);
    }

    const data = (await response.json()) as CopilotModelsResponse;
    return Array.isArray(data.data) ? data.data : [];
  }
}

/** 全局单例 Token 管理器 */
export const copilotTokenManager: CopilotTokenManager = new CopilotTokenManager();

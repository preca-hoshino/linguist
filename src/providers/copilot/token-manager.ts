// src/providers/copilot/token-manager.ts — Copilot 短效 Token 获取与缓存管理

import { createLogger, GatewayError, logColors } from '@/utils';
import { COPILOT_EDITOR_HEADERS, COPILOT_TOKEN_URL, TOKEN_REFRESH_MARGIN_SECONDS } from './constants';

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

/**
 * Copilot Token 管理器
 *
 * 职责：
 * - 使用长效 access_token 换取短效 Copilot Token（约 30 分钟有效期）
 * - 按 providerId 隔离缓存，支持多个 Copilot 提供商实例并存
 * - 在 Token 过期前 TOKEN_REFRESH_MARGIN_SECONDS 秒自动刷新
 * - 防止同一 Provider 的并发刷新请求（使用 pending Map）
 */
export class CopilotTokenManager {
  /** providerId → CopilotTokenInfo */
  private readonly cache = new Map<string, CopilotTokenInfo>();
  /** providerId → 正在进行的刷新 Promise（防止并发请求） */
  private readonly pending = new Map<string, Promise<CopilotTokenInfo>>();

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
}

/** 全局单例 Token 管理器 */
export const copilotTokenManager: CopilotTokenManager = new CopilotTokenManager();

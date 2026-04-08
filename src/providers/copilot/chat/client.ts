// src/providers/copilot/chat/client.ts — Copilot 聊天 HTTP 客户端

import { mapCopilotError } from '@/providers/copilot/error-mapping';
import { copilotTokenManager } from '@/providers/copilot/token-manager';
import { parseProviderResponse } from '@/providers/http-utils';
import type { ProviderChatClient } from '@/providers/types';
import type { CopilotCredential, ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';
import { COPILOT_CHAT_HEADERS } from '../constants';

const logger = createLogger('Provider:Copilot', logColors.bold + logColors.cyan);

/**
 * Copilot 聊天客户端
 *
 * 与 DeepSeek 客户端的核心差异：
 * - Token 动态获取：每次请求前从 CopilotTokenManager 获取有效的短效 Token
 * - 动态 base URL：API 端点从 Token 响应的 endpoints.api 解析（个人版/企业版不同）
 * - 特殊 Headers：附加模拟 VS Code 客户端的头部（Copilot-Integration-Id 等）
 * - 构造函数接收完整 ProviderConfig（而非单纯 apiKey），因为需要访问 credential
 */
export class CopilotChatClient implements ProviderChatClient {
  private readonly config: ProviderConfig;

  public constructor(config: ProviderConfig) {
    this.config = config;
    logger.debug({ providerId: config.id }, 'Copilot chat client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const { token, apiEndpoint } = await this.resolveToken();
    const url = `${apiEndpoint}/chat/completions`;

    logger.debug({ url, model, providerId: this.config.id }, 'Calling Copilot API');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_CHAT_HEADERS,
    };

    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    const duration = Date.now() - start;
    const { body, responseHeaders } = await parseProviderResponse(
      response,
      'Copilot',
      logger,
      { duration, model },
      mapCopilotError,
    );
    return { body, requestHeaders, responseHeaders };
  }

  public async callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult> {
    const { token, apiEndpoint } = await this.resolveToken();
    const url = `${apiEndpoint}/chat/completions`;

    logger.debug({ url, model, providerId: this.config.id }, 'Calling Copilot API (stream)');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_CHAT_HEADERS,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'Copilot API stream error');
      const errorInfo = mapCopilotError(response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `Copilot API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'Copilot API stream connected');
    return { response, requestHeaders };
  }

  /**
   * 从 CopilotTokenManager 获取有效的短效 Token + API 端点
   * Token 过期时自动刷新（对调用方透明）
   */
  private async resolveToken(): Promise<{ token: string; apiEndpoint: string }> {
    const credential = this.config.credential as CopilotCredential;
    return await copilotTokenManager.getToken(this.config.id, credential.accessToken);
  }
}

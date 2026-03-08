// src/providers/chat/volcengine/client.ts — 火山引擎聊天客户端

import type { ProviderChatClient } from '../interface';
import type { ProviderCallResult, ProviderStreamResult } from '../../../types';
import { createLogger, logColors, GatewayError, DEFAULT_PROVIDER_TIMEOUT } from '../../../utils';
import { mapProviderError } from '../../error-mapping';
import { parseProviderResponse } from '../../response-parser';

const logger = createLogger('Provider:VolcEngine', logColors.bold + logColors.magenta);

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 火山引擎聊天客户端
 * 封装与火山引擎 Chat Completions API 的 HTTP 通信
 *
 * 端点格式：POST {baseUrl}/chat/completions
 * 认证方式：Authorization: Bearer {API_KEY}
 */
export class VolcEngineChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    logger.debug({ baseUrl: this.baseUrl }, 'VolcEngine chat client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling VolcEngine API');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const timeout = DEFAULT_PROVIDER_TIMEOUT;
    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(timeout),
    });

    const duration = Date.now() - start;
    const { body, responseHeaders } = await parseProviderResponse(response, 'volcengine', 'VolcEngine', logger, {
      duration,
      model,
    });
    return { body, requestHeaders, responseHeaders };
  }

  public async callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling VolcEngine API (stream)');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'VolcEngine API stream error');
      const errorInfo = mapProviderError('volcengine', response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `VolcEngine API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'VolcEngine API stream connected');
    return { response, requestHeaders };
  }
}

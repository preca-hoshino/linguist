// src/providers/chat/deepseek/client.ts

import type { ProviderChatClient } from '../interface';
import type { ProviderCallResult, ProviderStreamResult } from '../../../types';
import { createLogger, logColors, GatewayError, DEFAULT_PROVIDER_TIMEOUT } from '../../../utils';
import { mapProviderError } from '../../error-mapping';
import { parseProviderResponse } from '../../response-parser';

const logger = createLogger('Provider:DeepSeek', logColors.bold + logColors.green);

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek 聊天客户端
 * 封装与 DeepSeek API 的 HTTP 通信
 */
export class DeepSeekChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    logger.debug({ baseUrl: this.baseUrl }, 'DeepSeek chat client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling DeepSeek API');

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
    const { body, responseHeaders } = await parseProviderResponse(response, 'deepseek', 'DeepSeek', logger, {
      duration,
      model,
    });
    return { body, requestHeaders, responseHeaders };
  }

  public async callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling DeepSeek API (stream)');

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
      logger.error({ status: response.status, body: errorBody, model }, 'DeepSeek API stream error');
      const errorInfo = mapProviderError('deepseek', response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `DeepSeek API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'DeepSeek API stream connected');
    return { response, requestHeaders };
  }
}

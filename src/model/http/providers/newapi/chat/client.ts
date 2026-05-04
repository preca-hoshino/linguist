// src/model/http/providers/newapi/chat/client.ts — New API 聊天客户端
//
// 封装与 New API 的 HTTP 通信，使用 OpenAI 兼容的 /chat/completions 端点

import { mapNewApiError } from '@/model/http/providers/newapi/error-mapping';
import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderCallOptions, ProviderChatClient } from '@/model/http/providers/types';
import type { ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:NewApi', logColors.bold + logColors.magenta);

/**
 * New API 聊天客户端
 * 封装与 New API 的 HTTP 通信
 */
export class NewApiChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(config: ProviderConfig) {
    const cred = config.credential;
    if (cred.type !== 'api_key') {
      throw new GatewayError(500, 'config_error', `New API requires api_key credential, got: ${cred.type}`);
    }
    this.apiKey = cred.key;
    if (config.baseUrl.length === 0) {
      throw new GatewayError(500, 'config_error', 'New API requires a non-empty base_url');
    }
    let resolvedUrl = config.baseUrl;
    while (resolvedUrl.endsWith('/')) {
      resolvedUrl = resolvedUrl.slice(0, -1);
    }
    this.baseUrl = resolvedUrl;
    logger.debug({ baseUrl: this.baseUrl }, 'New API chat client initialized');
  }

  public async call(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling New API');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (options?.headers !== undefined) {
      for (const [key, val] of Object.entries(options.headers)) {
        if (val === null || val === '') {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete requestHeaders[key];
        } else {
          requestHeaders[key] = val;
        }
      }
    }

    const timeout = options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT;
    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(timeout),
    });

    const duration = Date.now() - start;
    const { body, statusCode, responseHeaders } = await parseProviderResponse(
      response,
      'NewApi',
      logger,
      {
        duration,
        model,
      },
      mapNewApiError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }

  public async callStream(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderStreamResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling New API (stream)');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (options?.headers !== undefined) {
      for (const [key, val] of Object.entries(options.headers)) {
        if (val === null || val === '') {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete requestHeaders[key];
        } else {
          requestHeaders[key] = val;
        }
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'New API stream error');
      const errorInfo = mapNewApiError(response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `New API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'New API stream connected');
    return { response, statusCode: response.status, requestHeaders };
  }
}

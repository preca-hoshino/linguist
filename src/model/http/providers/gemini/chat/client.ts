import { mapGeminiError } from '@/model/http/providers/gemini/error-mapping';
import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderChatClient } from '@/model/http/providers/types';
import type { ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:Gemini', logColors.bold + logColors.yellow);

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Gemini 聊天客户端
 * 封装与 Gemini generateContent API 的 HTTP 通信
 *
 * Gemini 端点格式：POST /v1beta/models/{model}:generateContent
 * 认证方式：x-goog-api-key header
 *
 * model 参数不在请求体中，而是嵌入 URL 路径。
 * model 通过 call() 的显式参数传入。
 */
export class GeminiChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly providerConfig: ProviderConfig;

  public constructor(config: ProviderConfig) {
    this.providerConfig = config;
    const cred = config.credential;
    if (cred.type !== 'api_key') {
      throw new GatewayError(500, 'config_error', `Gemini requires api_key credential, got: ${cred.type}`);
    }
    this.apiKey = cred.key;
    let resolvedUrl = config.baseUrl.length > 0 ? config.baseUrl : DEFAULT_BASE_URL;
    while (resolvedUrl.endsWith('/')) {
      resolvedUrl = resolvedUrl.slice(0, -1);
    }
    this.baseUrl = resolvedUrl;
    logger.debug({ baseUrl: this.baseUrl }, 'Gemini chat client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;
    logger.debug({ url, model }, 'Calling Gemini API');

    const requestHeaders: Record<string, string> = {
      'x-goog-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const customHeaders = this.providerConfig.config.custom_headers as Record<string, unknown> | undefined;
    if (customHeaders !== undefined) {
      for (const [key, val] of Object.entries(customHeaders)) {
        if (val === null || val === '') {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete requestHeaders[key];
        } else {
          requestHeaders[key] = val as string;
        }
      }
    }

    const timeout = DEFAULT_PROVIDER_TIMEOUT;
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
      'Gemini',
      logger,
      {
        duration,
        model,
      },
      mapGeminiError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }

  public async callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult> {
    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    logger.debug({ url, model }, 'Calling Gemini API (stream)');

    const requestHeaders: Record<string, string> = {
      'x-goog-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const customHeaders = this.providerConfig.config.custom_headers as Record<string, unknown> | undefined;
    if (customHeaders !== undefined) {
      for (const [key, val] of Object.entries(customHeaders)) {
        if (val === null || val === '') {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete requestHeaders[key];
        } else {
          requestHeaders[key] = val as string;
        }
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'Gemini API stream error');
      const errorInfo = mapGeminiError(response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `Gemini API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'Gemini API stream connected');
    return { response, statusCode: response.status, requestHeaders };
  }
}

import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderEmbeddingClient } from '@/model/http/providers/types';
import type { ProviderCallResult, ProviderConfig } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:Gemini:Embedding', logColors.bold + logColors.yellow);

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

import { mapGeminiError } from '@/model/http/providers/gemini/error-mapping';

/**
 * Gemini 嵌入客户端
 * 封装与 Gemini embedContent API 的 HTTP 通信
 *
 * 端点格式：POST /v1beta/models/{model}:embedContent
 * 认证方式：x-goog-api-key header
 */
export class GeminiEmbeddingClient implements ProviderEmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(config: ProviderConfig) {
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
    logger.debug({ baseUrl: this.baseUrl }, 'Gemini embedding client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/v1beta/models/${model}:embedContent`;
    logger.debug({ url, model }, 'Calling Gemini Embedding API');

    const requestHeaders: Record<string, string> = {
      'x-goog-api-key': this.apiKey,
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
    const { body, statusCode, responseHeaders } = await parseProviderResponse(
      response,
      'Gemini Embedding',
      logger,
      {
        duration,
        model,
      },
      mapGeminiError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }
}

// src/model/http/providers/newapi/embedding/client.ts — New API 嵌入客户端
//
// 封装与 New API 的 HTTP 通信，使用 OpenAI 兼容的 /embeddings 端点

import { mapNewApiError } from '@/model/http/providers/newapi/error-mapping';
import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderEmbeddingClient } from '@/model/http/providers/types';
import type { ProviderCallResult, ProviderConfig } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:NewApi:Embedding', logColors.bold + logColors.magenta);

/**
 * New API 嵌入客户端
 * 封装与 New API 的 HTTP 通信
 */
export class NewApiEmbeddingClient implements ProviderEmbeddingClient {
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
    logger.debug({ baseUrl: this.baseUrl }, 'New API embedding client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/embeddings`;
    logger.debug({ url, model }, 'Calling New API Embedding');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    const duration = Date.now() - start;
    const { body, statusCode, responseHeaders } = await parseProviderResponse(
      response,
      'NewApi',
      logger,
      { duration, model },
      mapNewApiError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }
}

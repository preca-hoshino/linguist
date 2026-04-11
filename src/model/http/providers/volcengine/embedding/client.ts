// src/providers/embedding/volcengine/client.ts — 火山引擎嵌入客户端

import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderEmbeddingClient } from '@/model/http/providers/types';
import type { ProviderCallResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, logColors } from '@/utils';

const logger = createLogger('Provider:VolcEngine:Embedding', logColors.bold + logColors.magenta);

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

import { mapVolcEngineError } from '@/model/http/providers/volcengine/error-mapping';

/**
 * 火山引擎多模态嵌入客户端
 * 封装与火山引擎 Embeddings Multimodal API 的 HTTP 通信
 *
 * 端点格式：POST {baseUrl}/embeddings/multimodal
 * 认证方式：Authorization: Bearer {API_KEY}
 */
export class VolcEngineEmbeddingClient implements ProviderEmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    let resolvedUrl = baseUrl ?? DEFAULT_BASE_URL;
    while (resolvedUrl.endsWith('/')) {
      resolvedUrl = resolvedUrl.slice(0, -1);
    }
    this.baseUrl = resolvedUrl;
    logger.debug({ baseUrl: this.baseUrl }, 'VolcEngine embedding client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/embeddings/multimodal`;
    logger.debug({ url, model }, 'Calling VolcEngine Embedding API');

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
    const { body, responseHeaders } = await parseProviderResponse(
      response,
      'VolcEngine Embedding',
      logger,
      {
        duration,
        model,
      },
      mapVolcEngineError,
    );
    return { body, requestHeaders, responseHeaders };
  }
}

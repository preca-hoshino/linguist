// src/providers/embedding/volcengine/client.ts — 火山引擎嵌入客户端

import type { ProviderEmbeddingClient } from '../interface';
import type { ProviderCallResult } from '../../../types';
import { createLogger, logColors, DEFAULT_PROVIDER_TIMEOUT } from '../../../utils';
import { parseProviderResponse } from '../../response-parser';

const logger = createLogger('Provider:VolcEngine:Embedding', logColors.bold + logColors.magenta);

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

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

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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
      'volcengine',
      'VolcEngine Embedding',
      logger,
      {
        duration,
        model,
      },
    );
    return { body, requestHeaders, responseHeaders };
  }
}

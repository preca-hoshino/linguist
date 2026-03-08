// src/providers/embedding/gemini/client.ts — Gemini 嵌入客户端

import type { ProviderEmbeddingClient } from '../interface';
import type { ProviderCallResult } from '../../../types';
import { createLogger, logColors, DEFAULT_PROVIDER_TIMEOUT } from '../../../utils';
import { parseProviderResponse } from '../../response-parser';

const logger = createLogger('Provider:Gemini:Embedding', logColors.bold + logColors.yellow);

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

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

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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
    const { body, responseHeaders } = await parseProviderResponse(response, 'gemini', 'Gemini Embedding', logger, {
      duration,
      model,
    });
    return { body, requestHeaders, responseHeaders };
  }
}

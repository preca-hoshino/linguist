// src/providers/copilot/embedding/client.ts — Copilot 嵌入调用客户端

import { COPILOT_CHAT_HEADERS } from '@/model/http/providers/copilot/constants';
import { mapCopilotError } from '@/model/http/providers/copilot/error-mapping';
import { copilotTokenManager } from '@/model/http/providers/copilot/token-manager';
import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderEmbeddingClient } from '@/model/http/providers/types';
import type { CopilotCredential, ProviderCallResult, ProviderConfig } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, logColors } from '@/utils';

const logger = createLogger('Provider:Copilot:Embedding', logColors.bold + logColors.cyan);

/**
 * Copilot 嵌入 HTTP 客户端
 * 基于提取出的 apiEndpoint，使用 /v1/embeddings Endpoint 发送请求。
 */
export class CopilotEmbeddingClient implements ProviderEmbeddingClient {
  private readonly config: ProviderConfig;

  public constructor(config: ProviderConfig) {
    this.config = config;
    logger.debug({ providerId: config.id }, 'Copilot embedding client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const { token, apiEndpoint } = await this.resolveToken();
    const url = `${apiEndpoint}/embeddings`;

    logger.debug({ url, model, providerId: this.config.id }, 'Calling Copilot Embedding API');

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

  /**
   * 从 CopilotTokenManager 获取有效的短效 Token
   */
  private async resolveToken(): Promise<{ token: string; apiEndpoint: string }> {
    const credential = this.config.credential as CopilotCredential;
    return await copilotTokenManager.getToken(this.config.id, credential.accessToken);
  }
}

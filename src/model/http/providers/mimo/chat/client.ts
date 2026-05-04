// src/providers/mimo/chat/client.ts — MiMo HTTP 客户端

import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderCallOptions, ProviderChatClient } from '@/model/http/providers/types';
import type { ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';
import { mapMimoError } from '../error-mapping';

const logger = createLogger('Provider:MiMo', logColors.bold + logColors.blue);

/**
 * MiMo 聊天客户端
 * 封装与 MiMo API 的 HTTP 通信
 *
 * 认证方式：
 * - 同时发送 api-key 和 Authorization: Bearer（双重兼容）
 * - api-key header 为 MiMo 推荐方式，Authorization 为 OpenAI 标准方式
 */
export class MiMoChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(config: ProviderConfig) {
    const cred = config.credential;
    if (cred.type !== 'api_key') {
      throw new GatewayError(500, 'config_error', `MiMo requires api_key credential, got: ${cred.type}`);
    }
    this.apiKey = cred.key;
    if (config.baseUrl.length === 0) {
      throw new GatewayError(500, 'config_error', 'MiMo requires a non-empty base_url');
    }
    let resolvedUrl = config.baseUrl;
    while (resolvedUrl.endsWith('/')) {
      resolvedUrl = resolvedUrl.slice(0, -1);
    }
    this.baseUrl = resolvedUrl;
    logger.debug({ baseUrl: this.baseUrl }, 'MiMo chat client initialized');
  }

  public async call(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderCallResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling MiMo API');

    const requestHeaders = this.buildHeaders(options);

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
      'MiMo',
      logger,
      { duration, model },
      mapMimoError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }

  public async callStream(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderStreamResult> {
    const url = `${this.baseUrl}/chat/completions`;
    logger.debug({ url, model }, 'Calling MiMo API (stream)');

    const requestHeaders = this.buildHeaders(options);

    const timeout = options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT;
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(providerReq),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // 解析错误响应体并调用 mapMimoError
      const parsed: unknown = ((): unknown => {
        try {
          return JSON.parse(errorText) as unknown;
        } catch {
          return null;
        }
      })();
      const providerDetail = {
        statusCode: response.status,
        rawBody: errorText,
      };
      // 提取错误信息用于日志
      let errorMessage = errorText;
      if (typeof parsed === 'object' && parsed !== null) {
        const err = (parsed as Record<string, unknown>).error;
        if (typeof err === 'object' && err !== null) {
          const msg = (err as Record<string, unknown>).message;
          if (typeof msg === 'string') {
            errorMessage = msg;
          }
        }
      }
      throw new GatewayError(502, 'provider_error', errorMessage, providerDetail);
    }

    return {
      response,
      statusCode: response.status,
      requestHeaders,
    };
  }

  /**
   * 构建请求头
   * 同时发送 api-key（MiMo 推荐）和 Authorization: Bearer（标准兼容）
   */
  private buildHeaders(options?: ProviderCallOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'api-key': this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    // 应用请求级别的 header 覆盖（来自 request_overrides）
    if (options?.headers !== undefined) {
      for (const [key, val] of Object.entries(options.headers)) {
        if (val === null || val === '') {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete headers[key];
        } else {
          headers[key] = val;
        }
      }
    }

    return headers;
  }
}

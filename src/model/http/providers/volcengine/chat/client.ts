import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderCallOptions, ProviderChatClient } from '@/model/http/providers/types';
import { mapVolcEngineError } from '@/model/http/providers/volcengine/error-mapping';
import type { ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:VolcEngine', logColors.bold + logColors.magenta);

/**
 * 火山引擎聊天客户端
 * 封装与火山引擎 Chat Completions API 的 HTTP 通信
 *
 * 端点格式：POST {baseUrl}/chat/completions
 * 认证方式：Authorization: Bearer {API_KEY}
 */
export class VolcEngineChatClient implements ProviderChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  public constructor(config: ProviderConfig) {
    const cred = config.credential;
    if (cred.type !== 'api_key') {
      throw new GatewayError(500, 'config_error', `VolcEngine requires api_key credential, got: ${cred.type}`);
    }
    this.apiKey = cred.key;
    if (config.baseUrl.length === 0) {
      throw new GatewayError(500, 'config_error', 'VolcEngine requires a non-empty base_url');
    }
    let resolvedUrl = config.baseUrl;
    while (resolvedUrl.endsWith('/')) {
      resolvedUrl = resolvedUrl.slice(0, -1);
    }
    this.baseUrl = resolvedUrl;
    logger.debug({ baseUrl: this.baseUrl }, 'VolcEngine chat client initialized');
  }

  /**
   * 根据 endpoint_type 解析实际的 Chat API URL
   *
   * 火山引擎有两种 API 基础路径:
   *   标准:   https://{host}/api/v3/chat/completions
   *   Coding Plan: https://{host}/api/coding/v3/chat/completions
   *
   * 用户可自定义 baseUrl，需要兼容以下场景:
   *   1. baseUrl 已是 Coding Plan 地址（以 /api/coding/v3 结尾）→ 直接使用
   *   2. baseUrl 以 /api/v3 结尾 → 替换为 /api/coding/v3
   *   3. baseUrl 不含上述路径 → 记录 warning，按标准路径请求
   *
   * @param endpointType 'coding_plan' | 'normal' | undefined
   */
  private resolveEndpointUrl(endpointType?: string): string {
    if (endpointType === 'coding_plan') {
      // 场景 1: baseUrl 已指向 Coding Plan（如用户手动配置了 coding 地址）
      if (this.baseUrl.endsWith('/api/coding/v3')) {
        return `${this.baseUrl}/chat/completions`;
      }
      // 场景 2: baseUrl 为标准火山引擎格式，替换路径片段
      if (this.baseUrl.endsWith('/api/v3')) {
        return `${this.baseUrl.replace(/\/api\/v3$/, '/api/coding/v3')}/chat/completions`;
      }
      // 场景 3: 无法识别的自定义 baseUrl，无法安全推断 Coding Plan 端点
      logger.warn(
        { baseUrl: this.baseUrl, endpointType },
        'coding_plan endpoint requested but baseUrl does not match /api/v3 or /api/coding/v3 suffix, using baseUrl as-is',
      );
    }
    return `${this.baseUrl}/chat/completions`;
  }

  public async call(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderCallResult> {
    const url = this.resolveEndpointUrl(options?.modelConfig?.endpoint_type as string | undefined);
    logger.debug({ url, model }, 'Calling VolcEngine API');

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
      'VolcEngine',
      logger,
      {
        duration,
        model,
      },
      mapVolcEngineError,
    );
    return { body, statusCode, requestHeaders, responseHeaders };
  }

  public async callStream(
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderStreamResult> {
    const url = this.resolveEndpointUrl(options?.modelConfig?.endpoint_type as string | undefined);
    logger.debug({ url, model }, 'Calling VolcEngine API (stream)');

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
      signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'VolcEngine API stream error');
      const errorInfo = mapVolcEngineError(response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `VolcEngine API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model }, 'VolcEngine API stream connected');
    return { response, statusCode: response.status, requestHeaders };
  }
}

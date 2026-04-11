// src/providers/copilot/chat/client.ts — Copilot 聊天 HTTP 客户端（多端点动态路由）

import { mapCopilotError } from '@/model/http/providers/copilot/error-mapping';
import { copilotTokenManager } from '@/model/http/providers/copilot/token-manager';
import { parseProviderResponse } from '@/model/http/providers/http-utils';
import type { ProviderChatClient } from '@/model/http/providers/types';
import type { CopilotCredential, ProviderCallResult, ProviderConfig, ProviderStreamResult } from '@/types';
import { createLogger, DEFAULT_PROVIDER_TIMEOUT, GatewayError, logColors } from '@/utils';
import { COPILOT_CHAT_HEADERS } from '../constants';
import { translateChatToAnthropicPayload } from './fallback/messages';
import { translateChatToResponsesPayload } from './fallback/responses';
import type { CopilotEndpointType } from './fallback/types';

const logger = createLogger('Provider:Copilot', logColors.bold + logColors.cyan);

/**
 * 根据端点类型解析目标 URL 路径
 */
function resolveRequestUrl(apiEndpoint: string, endpointType: CopilotEndpointType): string {
  switch (endpointType) {
    case 'messages': {
      return `${apiEndpoint}/v1/messages`;
    }
    case 'responses': {
      return `${apiEndpoint}/responses`;
    }
    default: {
      return `${apiEndpoint}/chat/completions`;
    }
  }
}

/**
 * 根据端点类型转换请求负载
 * - 'chat-completions': 原样透传（已是 OpenAI 格式）
 * - 'messages':         转换为 Anthropic Messages Payload
 * - 'responses':        转换为 OpenAI Responses API Payload
 */
function transformPayload(
  providerReq: Record<string, unknown>,
  endpointType: CopilotEndpointType,
): Record<string, unknown> {
  switch (endpointType) {
    case 'messages': {
      return translateChatToAnthropicPayload(providerReq) as unknown as Record<string, unknown>;
    }
    case 'responses': {
      return translateChatToResponsesPayload(providerReq) as unknown as Record<string, unknown>;
    }
    default: {
      return providerReq;
    }
  }
}

/**
 * Copilot 聊天客户端
 *
 * 与初始实现的核心差异：
 * - 端点自动协商：每次请求前调用 getEndpointType()，根据模型的 supported_endpoints
 *   自动选择 /chat/completions / /v1/messages / /responses 三种协议之一
 * - 负载变形：非 chat-completions 端点时，将 OpenAI 格式负载转换为目标协议格式
 * - 端点标记注入：
 *   - 非流式：通过不可枚举属性 __copilotEndpoint 传递端点类型给 ResponseAdapter
 *   - 流式：通过 x-copilot-endpoint 响应头传递端点类型给 StreamResponseAdapter
 */
export class CopilotChatClient implements ProviderChatClient {
  private readonly config: ProviderConfig;

  public constructor(config: ProviderConfig) {
    this.config = config;
    logger.debug({ providerId: config.id }, 'Copilot chat client initialized');
  }

  public async call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult> {
    const { token, apiEndpoint } = await this.resolveToken();
    const endpointType = await copilotTokenManager.getEndpointType(this.config.id, token, apiEndpoint, model);
    const url = resolveRequestUrl(apiEndpoint, endpointType);
    const finalBody = transformPayload(providerReq, endpointType);

    logger.debug({ url, model, endpointType, providerId: this.config.id }, 'Calling Copilot API');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_CHAT_HEADERS,
    };

    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(finalBody),
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

    // 将端点类型注入为不可枚举属性，避免影响 JSON.stringify / 审计日志
    Object.defineProperty(body, '__copilotEndpoint', {
      value: endpointType,
      enumerable: false,
      writable: false,
      configurable: false,
    });

    return { body, requestHeaders, responseHeaders };
  }

  public async callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult> {
    const { token, apiEndpoint } = await this.resolveToken();
    const endpointType = await copilotTokenManager.getEndpointType(this.config.id, token, apiEndpoint, model);
    const url = resolveRequestUrl(apiEndpoint, endpointType);
    const finalBody = transformPayload(providerReq, endpointType);

    logger.debug({ url, model, endpointType, providerId: this.config.id }, 'Calling Copilot API (stream)');

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...COPILOT_CHAT_HEADERS,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(finalBody),
      signal: AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody, model }, 'Copilot API stream error');
      const errorInfo = mapCopilotError(response.status, errorBody);
      throw new GatewayError(
        errorInfo.gatewayStatusCode,
        errorInfo.gatewayErrorCode,
        `Copilot API returned ${String(response.status)}: ${errorInfo.message}`,
        { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
      );
    }

    logger.debug({ status: response.status, model, endpointType }, 'Copilot API stream connected');

    // 将端点类型注入到响应头，供 StreamResponseAdapter 读取
    const wrappedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        'x-copilot-endpoint': endpointType,
      },
    });

    return { response: wrappedResponse, requestHeaders };
  }

  /**
   * 从 CopilotTokenManager 获取有效的短效 Token + API 端点
   * Token 过期时自动刷新（对调用方透明）
   */
  private async resolveToken(): Promise<{ token: string; apiEndpoint: string }> {
    const credential = this.config.credential as CopilotCredential;
    return await copilotTokenManager.getToken(this.config.id, credential.accessToken);
  }
}

// tests/providers/volcengine.test.ts — VolcEngine 插件单元测试

import { clearAllMocks, setupVolcEngineMock } from '@/tests/helpers/mock-server';
import type { GatewayError } from '@/utils';
import { volcenginePlugin } from '../../providers/volcengine';

describe('Provider Plugin: VolcEngine', () => {
  const config = {
    id: 'vc-1',
    kind: 'volcengine',
    name: 'VolcEngine',
    credential: { type: 'api_key' as const, key: 'volc-abc' },
    baseUrl: 'https://ark.cn-beijing.volces.com',
    config: { http_proxy: '' },
  };

  beforeEach(() => {
    clearAllMocks();
  });

  it('should assemble client and adapters', () => {
    const chatSet = volcenginePlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
    expect(chatSet?.client).toBeDefined();
    expect(chatSet?.requestAdapter).toBeDefined();
  });

  describe('Client Calls', () => {
    it('should successfully call the volcengine chat api', async () => {
      const mockData = {
        choices: [{ message: { content: 'volc response' } }],
        usage: { total_tokens: 20 },
      };

      setupVolcEngineMock().post('/chat/completions').reply(200, mockData);

      const set = volcenginePlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('set undefined');
      }
      const result = await set.client.call({ messages: [{ role: 'user', content: 'hello' }] }, 'ep-123');

      const body = result.body as { choices: { message: { content: string } }[] };
      expect(body.choices[0]).toBeDefined();
      expect(body.choices[0]?.message.content).toBe('volc response');
    });

    it('should throw GatewayError on API error', async () => {
      setupVolcEngineMock()
        .post('/chat/completions')
        .reply(400, { error: { code: 'InvalidParameter', message: 'Wrong param' } });

      const set = volcenginePlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('set undefined');
      }
      const promise = set.client.call({ messages: [] }, 'ep-123');

      await expect(promise).rejects.toThrow();
      try {
        await promise;
      } catch (error) {
        const err = error as GatewayError;
        expect(err.name).toBe('GatewayError');
        expect(err.statusCode).toBe(400);
      }
    });
  });

  describe('Error Mapping', () => {
    it('should map InvalidParameter to invalid_request_error', () => {
      const errorBody = JSON.stringify({ error: { code: 'InvalidParameter', message: 'Wrong param' } });
      const info = volcenginePlugin.mapError(400, errorBody);
      expect(info.gatewayErrorCode).toBe('invalid_parameter');
    });

    it('should map InternalServiceError to provider_error', () => {
      const errorBody = JSON.stringify({ error: { code: 'InternalServiceError' } });
      const info = volcenginePlugin.mapError(500, errorBody);
      expect(info.gatewayErrorCode).toBe('provider_error');
    });

    it('should map token exceed messages to context_length_exceeded via exact provider error codes', () => {
      const errorBody = JSON.stringify({ error: { code: 'OutofContextError', message: 'Token max limit exceeded' } });
      const info = volcenginePlugin.mapError(400, errorBody);
      expect(info.gatewayErrorCode).toBe('context_length_exceeded');
    });

    it('should map token exceed messages to context_length_exceeded via fallback regex', () => {
      const errorBody = JSON.stringify({ error: { code: 'Unknown', message: 'The context length is too long.' } });
      const info = volcenginePlugin.mapError(400, errorBody);
      expect(info.gatewayErrorCode).toBe('context_length_exceeded');
    });

    it('should fallback to 403 mappings correctly for overdue errors', () => {
      const overrideError = JSON.stringify({ error: { code: 'AccountOverdue', message: 'balance empty' } });
      expect(volcenginePlugin.mapError(403, overrideError).gatewayErrorCode).toBe('insufficient_balance');

      const genericDenied = JSON.stringify({ error: { code: 'OperationDenied', message: 'denied' } });
      expect(volcenginePlugin.mapError(403, genericDenied).gatewayErrorCode).toBe('permission_denied');
    });

    it('should default to generic fallback when pattern fails', () => {
      expect(volcenginePlugin.mapError(429, 'just a text').gatewayErrorCode).toBe('rate_limit_exceeded');
    });
  });
});

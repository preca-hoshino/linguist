// tests/providers/deepseek.test.ts — DeepSeek 插件单元测试

import { clearAllMocks, setupDeepSeekMock } from '@/tests/helpers/mock-server';
import type { GatewayError } from '@/utils';
import { deepseekPlugin } from '../../providers/deepseek';

describe('Provider Plugin: DeepSeek', () => {
  const config = {
    apiKey: 'sk-test-key',
    baseUrl: 'https://api.deepseek.com',
  };

  describe('Adapter Set Assembly', () => {
    it('should assemble a complete adapter set', () => {
      const set = deepseekPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      expect(set?.requestAdapter).toBeDefined();
      expect(set?.responseAdapter).toBeDefined();
      expect(set?.client).toBeDefined();
    });

    it('should have correct plugin kind', () => {
      expect(deepseekPlugin.kind).toBe('deepseek');
    });
  });

  describe('Client Calls', () => {
    beforeEach(() => {
      clearAllMocks();
    });

    it('should successfully call the deepseek chat api', async () => {
      const mockData = {
        choices: [{ message: { content: 'test response' } }],
        usage: { total_tokens: 10 },
      };

      setupDeepSeekMock().post('/chat/completions').reply(200, mockData);

      const set = deepseekPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('set undefined');
      }
      const result = await set.client.call({ messages: [{ role: 'user', content: 'test' }] }, 'deepseek-chat');

      const body = result.body as { choices: { message: { content: string } }[] };
      expect(body.choices[0]).toBeDefined();
      expect(body.choices[0]?.message.content).toBe('test response');
    });

    it('should throw GatewayError on API error', async () => {
      setupDeepSeekMock()
        .post('/chat/completions')
        .reply(401, { error: { message: 'Invalid API Key', type: 'AuthenticationError' } });

      const set = deepseekPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('set undefined');
      }
      const promise = set.client.call({ messages: [] }, 'deepseek-chat');

      await expect(promise).rejects.toThrow();
      try {
        await promise;
      } catch (error) {
        const err = error as GatewayError;
        expect(err.name).toBe('GatewayError');
        expect(err.statusCode).toBe(401);
      }
    });
  });

  describe('Error Mapping', () => {
    it('should map 401 to invalid_api_key', () => {
      const errorBody = JSON.stringify({ error: { message: 'Bad API Key', type: 'AuthenticationError' } });
      const info = deepseekPlugin.mapError(401, errorBody);
      expect(info.gatewayErrorCode).toBe('authentication_error');
      expect(info.gatewayStatusCode).toBe(401);
    });

    it('should handle rate limiting (429)', () => {
      const errorBody = 'Rate limit exceeded';
      const info = deepseekPlugin.mapError(429, errorBody);
      expect(info.gatewayErrorCode).toBe('rate_limit_exceeded');
    });

    it('should fallback for unknown errors', () => {
      const info = deepseekPlugin.mapError(500, 'Internal Server Error');
      expect(info.gatewayErrorCode).toBe('provider_error');
    });
  });
});

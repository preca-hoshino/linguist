// tests/providers/gemini.test.ts — Gemini 插件单元测试

import type { GatewayError } from '@/utils/errors';
import { clearAllMocks, setupGeminiMock } from '@/tests/helpers/mock-server';
import { geminiPlugin } from '../providers/gemini';

describe('Provider Plugin: Gemini', () => {
  const config = {
    apiKey: 'AIza...',
    baseUrl: 'https://generativelanguage.googleapis.com',
  };

  beforeEach(() => {
    clearAllMocks();
  });

  it('should assemble chat and embedding adapter sets', () => {
    const chatSet = geminiPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
    const embedSet = geminiPlugin.getEmbeddingAdapterSet?.(config as unknown as import('@/types').ProviderConfig);

    expect(chatSet?.client).toBeDefined();
    expect(embedSet?.client).toBeDefined();
  });

  describe('Client Calls', () => {
    it('should successfully call the gemini generateContent api', async () => {
      const mockData = {
        candidates: [{ content: { parts: [{ text: 'gemini response' }] } }],
        usageMetadata: { totalTokenCount: 30 },
      };

      const model = 'gemini-1.5-flash';
      setupGeminiMock().post(`/v1beta/models/${model}:generateContent`).reply(200, mockData);

      const set = geminiPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('Chat adapter set is undefined');
      }
      const result = await set.client.call({ contents: [{ parts: [{ text: 'hello' }] }] }, model);

      const body = result.body as { candidates: [{ content: { parts: [{ text: string }] } }] };
      expect(body.candidates[0].content.parts[0].text).toBe('gemini response');
    });

    it('should throw GatewayError on API error', async () => {
      const model = 'gemini-1.5-flash';
      setupGeminiMock()
        .post(`/v1beta/models/${model}:generateContent`)
        .reply(400, { error: { message: 'Invalid API Key', status: 'INVALID_ARGUMENT' } });

      const set = geminiPlugin.getChatAdapterSet?.(config as unknown as import('@/types').ProviderConfig);
      if (!set) {
        throw new Error('Chat adapter set is undefined');
      }
      const promise = set.client.call({ contents: [] }, model);

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
    it('should map 400 with API_KEY_INVALID to invalid_api_key', () => {
      const errorBody = JSON.stringify({
        error: { message: 'Invalid API Key', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
      });
      const info = geminiPlugin.mapError(400, errorBody);
      expect(info.gatewayErrorCode).toBe('invalid_request');
    });
  });
});

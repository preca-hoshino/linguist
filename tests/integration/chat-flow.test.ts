// tests/integration/chat-flow.test.ts — 基于 Mock 的集成聊天链路测试

import { v4 as uuidv4 } from '@/utils/uuid';
import { OpenAICompatChatRequestAdapter } from '../../src/users/openaicompat/chat/request';
import { OpenAICompatChatResponseAdapter } from '../../src/users/openaicompat/chat/response';
import { dispatchChatProvider } from '../../src/providers/engine';
import { setupDeepSeekMock, clearAllMocks } from '@/tests/helpers/mock-server';
import type { GatewayContext } from '../../src/types';

describe('Integration: OpenAICompat -> DeepSeek -> Gateway', () => {
  beforeEach(() => {
    clearAllMocks();
  });

  it('should process a full non-streaming request-response cycle using Mocks', async () => {
    // 1. Prepare Mock
    const mockData = {
      id: 'ds-resp-1',
      choices: [{ message: { content: 'Mocked hello' }, finish_reason: 'stop' }],
      usage: { total_tokens: 50 }
    };
    
    // 使用 () => true 忽略对 body 的具体校验，专注于验证网关流转链路
    setupDeepSeekMock()
      .post('/chat/completions', () => true)
      .reply(200, mockData);

    // 2. User Input
    const userReq = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] };
    const userRequestAdapter = new OpenAICompatChatRequestAdapter();
    const internalReq = userRequestAdapter.toInternal(userReq);

    // 3. Context Preparation
    const mockContext = {
      id: uuidv4(),
      requestModel: 'deepseek-chat',
      route: {
        providerKind: 'deepseek',
        model: 'deepseek-chat',
        capabilities: { chat: true, embedding: false },
        providerConfig: { apiKey: 'sk-123', baseUrl: 'https://api.deepseek.com' }
      },
      audit: {},
      timing: { start: Date.now() },
      response: {}
    } as any;

    // 4. Provider Processing
    await dispatchChatProvider(mockContext, internalReq);

    // 5. Output validation
    const internalRes = mockContext.response;
    expect(internalRes.choices[0].message.content).toBe('Mocked hello');

    // 6. User Response Adapter
    const ctx: GatewayContext = {
      ...mockContext,
      ip: '127.0.0.1',
      http: { method: 'POST', path: '/v1/chat/completions' },
      userFormat: 'openaicompat',
      requestModel: 'gpt-4',
    };

    const userResponseAdapter = new OpenAICompatChatResponseAdapter();
    const finalRes = userResponseAdapter.fromInternal(ctx) as any;

    expect(finalRes.choices[0].message.content).toBe('Mocked hello');
    expect(finalRes.usage.total_tokens).toBe(50);
  });
});

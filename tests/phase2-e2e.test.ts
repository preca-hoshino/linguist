// tests/phase2-e2e.test.ts — Phase 2 端到端测试
// 验证：OpenAI 兼容格式请求 → DeepSeek 提供商 → OpenAI 兼容格式响应

import { v4 as uuidv4 } from 'uuid';

// ==================== 用户适配器测试 ====================
import { OpenAICompatChatRequestAdapter } from '../src/users/chat/openaicompat/request';
import { OpenAICompatChatResponseAdapter } from '../src/users/chat/openaicompat/response';
import type { GatewayContext } from '../src/types';
import type { InternalChatRequest, InternalChatResponse } from '../src/types';

// ==================== 提供商适配器测试 ====================
import { DeepSeekChatRequestAdapter } from '../src/providers/chat/deepseek/request';
import { DeepSeekChatResponseAdapter } from '../src/providers/chat/deepseek/response';

// ==================== 路由测试 ====================
import { route } from '../src/router';
import { configManager } from '../src/config/manager';

// ==================== 注册中心测试 ====================
import { getUserChatAdapter } from '../src/users';
import { getProviderChatAdapterSet } from '../src/providers';

// ==================== 中间件测试 ====================
import { applyMiddlewares } from '../src/middleware';
import type { Middleware } from '../src/middleware';

describe('Phase 2: 端到端聊天链路', () => {
  // ============================================================
  // OpenAI 兼容用户请求适配器
  // ============================================================
  describe('OpenAICompatChatRequestAdapter', () => {
    const adapter = new OpenAICompatChatRequestAdapter();

    it('should convert basic OpenAICompat request to internal format', () => {
      const userReq = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      };

      const result = adapter.toInternal(userReq);

      expect(result.messages).toEqual(userReq.messages);
      expect(result.stream).toBe(false);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(1000);
      // model 不应出现在 InternalChatRequest 中
      expect((result as any).model).toBeUndefined();
    });

    it('should preserve stream=true from user request', () => {
      const userReq = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      };

      const result = adapter.toInternal(userReq);
      expect(result.stream).toBe(true);
    });

    it('should handle tools and tool_choice', () => {
      const userReq = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather info',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'auto',
      };

      const result = adapter.toInternal(userReq);
      expect(result.tools).toHaveLength(1);
      expect(result.tool_choice).toBe('auto');
    });

    it('should handle thinking config', () => {
      const userReq = {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'Solve this math problem' }],
        thinking: { enabled: true, budget_tokens: 8192 },
      };

      const result = adapter.toInternal(userReq);
      expect(result.thinking).toEqual({ enabled: true, budget_tokens: 8192 });
    });

    it('should pass through optional parameters', () => {
      const userReq = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        top_p: 0.9,
        top_k: 50,
        stop: ['END'],
        presence_penalty: 0.5,
        frequency_penalty: 0.3,
      };

      const result = adapter.toInternal(userReq);
      expect(result.top_p).toBe(0.9);
      expect(result.top_k).toBe(50);
      expect(result.stop).toEqual(['END']);
      expect(result.presence_penalty).toBe(0.5);
      expect(result.frequency_penalty).toBe(0.3);
    });
  });

  // ============================================================
  // OpenAI 兼容用户响应适配器
  // ============================================================
  describe('OpenAICompatChatResponseAdapter', () => {
    const adapter = new OpenAICompatChatResponseAdapter();

    it('should assemble OpenAICompat response from GatewayContext', () => {
      const ctx: GatewayContext = {
        id: 'test-uuid-123',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'gpt-4',
        route: {
          model: 'deepseek-chat',
          modelType: 'chat',
          providerKind: 'deepseek',
          providerId: 'abc12345',
          providerConfig: {
            id: 'abc12345',
            kind: 'deepseek',
            name: 'DeepSeek',
            apiKey: 'sk-test',
            baseUrl: 'https://api.deepseek.com',
            isActive: true,
            config: {},
          },
          strategy: 'load_balance',
          capabilities: [],
        },
        response: {
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        } as InternalChatResponse,
        audit: {},
        timing: { start: 1700000000000 },
      };

      const result = adapter.fromInternal(ctx);

      expect(result.id).toBe('test-uuid-123');
      expect(result.object).toBe('chat.completion');
      expect(result.created).toBe(1700000000);
      expect(result.model).toBe('gpt-4');
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.usage.total_tokens).toBe(15);
    });
  });

  // ============================================================
  // DeepSeek 请求适配器
  // ============================================================
  describe('DeepSeekChatRequestAdapter', () => {
    const adapter = new DeepSeekChatRequestAdapter();

    it('should convert internal request to DeepSeek format', () => {
      const internalReq: InternalChatRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: 1000,
      };

      const result = adapter.toProviderRequest(internalReq, 'deepseek-chat');

      expect(result.model).toBe('deepseek-chat');
      expect(result.messages).toEqual(internalReq.messages);
      expect(result.stream).toBe(false);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(1000);
    });

    it('should map thinking config correctly', () => {
      const internalReq: InternalChatRequest = {
        messages: [{ role: 'user', content: 'Solve x^2 = 4' }],
        stream: false,
        thinking: { type: 'enabled', budget_tokens: 8192 },
      };

      const result = adapter.toProviderRequest(internalReq, 'deepseek-reasoner');

      expect(result.thinking).toEqual({ type: 'enabled' });
    });

    it('should map thinking disabled', () => {
      const internalReq: InternalChatRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
        thinking: { type: 'disabled' },
      };

      const result = adapter.toProviderRequest(internalReq, 'deepseek-chat');
      expect(result.thinking).toEqual({ type: 'disabled' });
    });

    it('should omit undefined optional parameters', () => {
      const internalReq: InternalChatRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      };

      const result = adapter.toProviderRequest(internalReq, 'deepseek-chat');

      expect(result.temperature).toBeUndefined();
      expect(result.max_tokens).toBeUndefined();
      expect(result.tools).toBeUndefined();
      expect(result.thinking).toBeUndefined();
    });

    it('should include tools when provided', () => {
      const internalReq: InternalChatRequest = {
        messages: [{ role: 'user', content: 'Weather?' }],
        stream: false,
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
      };

      const result = adapter.toProviderRequest(internalReq, 'deepseek-chat');

      expect(result.tools).toHaveLength(1);
      expect(result.tool_choice).toBe('auto');
    });
  });

  // ============================================================
  // DeepSeek 响应适配器
  // ============================================================
  describe('DeepSeekChatResponseAdapter', () => {
    const adapter = new DeepSeekChatResponseAdapter();

    it('should convert basic DeepSeek response to internal format', () => {
      const providerRes = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there!' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const result = adapter.fromProviderResponse(providerRes);

      // InternalChatResponse 不含 id/model/created
      expect((result as any).id).toBeUndefined();
      expect((result as any).model).toBeUndefined();
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.content).toBe('Hello there!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage?.total_tokens).toBe(15);
    });

    it('should handle reasoning_content from DeepSeek reasoner', () => {
      const providerRes = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'x = ±2',
              reasoning_content: 'Let me think step by step...',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 100,
          total_tokens: 120,
          completion_tokens_details: { reasoning_tokens: 80 },
        },
      };

      const result = adapter.fromProviderResponse(providerRes);

      expect(result.choices[0].message.reasoning_content).toBe('Let me think step by step...');
      expect(result.usage?.reasoning_tokens).toBe(80);
    });

    it('should handle tool_calls in response', () => {
      const providerRes = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city": "Beijing"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
      };

      const result = adapter.fromProviderResponse(providerRes);

      expect(result.choices[0].finish_reason).toBe('tool_calls');
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls![0].function.name).toBe('get_weather');
    });

    it('should map finish_reason correctly', () => {
      const testCases = [
        { input: 'stop', expected: 'stop' },
        { input: 'length', expected: 'length' },
        { input: 'tool_calls', expected: 'tool_calls' },
        { input: 'content_filter', expected: 'content_filter' },
        { input: 'unknown_reason', expected: 'unknown' },
      ];

      for (const tc of testCases) {
        const providerRes = {
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'test' },
              finish_reason: tc.input,
            },
          ],
        };

        const result = adapter.fromProviderResponse(providerRes);
        expect(result.choices[0].finish_reason).toBe(tc.expected);
      }
    });

    it('should handle cached tokens', () => {
      const providerRes = {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Cached response' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
        },
      };

      const result = adapter.fromProviderResponse(providerRes);
      expect(result.usage?.cached_tokens).toBe(80);
    });
  });

  // ============================================================
  // 路由模块
  // ============================================================
  describe('Router', () => {
    beforeEach(() => {
      // Mock configManager 内部数据
      (configManager as any).virtualModels = new Map();
      (configManager as any).providers = new Map();
    });

    it('should route virtual model to actual model', () => {
      // 设置 mock 提供商
      (configManager as any).providers.set('1', {
        id: '1',
        kind: 'deepseek',
        name: 'DeepSeek',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com',
        config: {},
      });

      // 设置 mock 虚拟模型（新数据结构：backends 数组）
      (configManager as any).virtualModels.set('gpt-4', {
        id: 'gpt-4',
        modelType: 'chat',
        routingStrategy: 'load_balance',
        backends: [
          {
            providerModelId: 'pm-1',
            actualModel: 'deepseek-chat',
            modelType: 'chat',
            capabilities: [],
            weight: 1,
            priority: 0,
            provider: (configManager as any).providers.get('1'),
          },
        ],
      });

      const ctx: GatewayContext = {
        id: 'test-id',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'gpt-4',
        audit: {},
        timing: { start: Date.now() },
      };

      route(ctx);

      expect(ctx.route?.model).toBe('deepseek-chat');
      expect(ctx.route?.modelType).toBe('chat');
      expect(ctx.route?.providerKind).toBe('deepseek');
      expect(ctx.route?.providerId).toBe('1');
      expect(ctx.route?.strategy).toBe('load_balance');
      expect(ctx.timing.routed).toBeDefined();
    });

    it('should throw GatewayError for unknown model', () => {
      const ctx: GatewayContext = {
        id: 'test-id',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'unknown-model',
        audit: {},
        timing: { start: Date.now() },
      };

      expect(() => route(ctx)).toThrow('Unknown model: unknown-model');
    });
  });

  // ============================================================
  // 用户适配器注册中心
  // ============================================================
  describe('User Adapter Registry', () => {
    it('should return openaicompat chat adapter', () => {
      const adapter = getUserChatAdapter('openaicompat');
      expect(adapter).toBeDefined();
      expect(adapter.request).toBeDefined();
      expect(adapter.response).toBeDefined();
    });

    it('should throw for unknown format', () => {
      expect(() => getUserChatAdapter('unknown')).toThrow('Unknown user chat format: unknown');
    });
  });

  // ============================================================
  // 提供商适配器注册中心
  // ============================================================
  describe('Provider Adapter Registry', () => {
    it('should return deepseek chat adapter set', () => {
      const config = { id: 1, type: 'deepseek', name: 'DeepSeek', apiKey: 'sk-test' };
      const adapterSet = getProviderChatAdapterSet('deepseek', config);

      expect(adapterSet.requestAdapter).toBeDefined();
      expect(adapterSet.responseAdapter).toBeDefined();
      expect(adapterSet.client).toBeDefined();
    });

    it('should throw for unknown provider', () => {
      const config = { id: 1, type: 'unknown', name: 'Unknown', apiKey: 'sk-test' };
      expect(() => getProviderChatAdapterSet('unknown', config)).toThrow('Unknown chat provider: unknown');
    });
  });

  // ============================================================
  // 中间件执行器
  // ============================================================
  describe('Middleware Executor', () => {
    it('should execute middlewares in order', async () => {
      const order: number[] = [];

      const mw1: Middleware = async () => {
        order.push(1);
      };
      const mw2: Middleware = async () => {
        order.push(2);
      };
      const mw3: Middleware = async () => {
        order.push(3);
      };

      const ctx: GatewayContext = {
        id: 'test',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'test',
        audit: {},
        timing: { start: Date.now() },
      };

      await applyMiddlewares(ctx, [mw1, mw2, mw3]);

      expect(order).toEqual([1, 2, 3]);
    });

    it('should pass context to each middleware', async () => {
      const mw: Middleware = async (ctx) => {
        (ctx as any).customField = 'added';
      };

      const ctx: GatewayContext = {
        id: 'test',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'test',
        audit: {},
        timing: { start: Date.now() },
      };

      await applyMiddlewares(ctx, [mw]);

      expect((ctx as any).customField).toBe('added');
    });

    it('should handle empty middleware list', async () => {
      const ctx: GatewayContext = {
        id: 'test',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'test',
        audit: {},
        timing: { start: Date.now() },
      };

      await expect(applyMiddlewares(ctx, [])).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // 端到端流程（模拟）
  // ============================================================
  describe('E2E: OpenAICompat → DeepSeek → OpenAICompat', () => {
    it('should transform through the full pipeline', () => {
      // 1. 用户 OpenAI 兼容格式请求
      const userReq = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
        ],
        temperature: 0.5,
        max_tokens: 100,
      };

      // 2. 用户适配器：OpenAICompat → Internal
      const requestAdapter = new OpenAICompatChatRequestAdapter();
      const internalReq = requestAdapter.toInternal(userReq);
      expect(internalReq.messages).toEqual(userReq.messages);
      expect((internalReq as any).model).toBeUndefined();

      // 3. 提供商请求适配：Internal → DeepSeek
      const providerRequestAdapter = new DeepSeekChatRequestAdapter();
      const providerReq = providerRequestAdapter.toProviderRequest(internalReq, 'deepseek-chat');
      expect(providerReq.model).toBe('deepseek-chat');
      expect(providerReq.messages).toEqual(userReq.messages);

      // 4. 模拟 DeepSeek 响应
      const deepseekRes = {
        id: 'chatcmpl-abc123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '2+2 equals 4.' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 25,
          completion_tokens: 8,
          total_tokens: 33,
        },
      };

      // 5. 提供商响应适配：DeepSeek → Internal
      const providerResponseAdapter = new DeepSeekChatResponseAdapter();
      const internalRes = providerResponseAdapter.fromProviderResponse(deepseekRes);
      expect(internalRes.choices[0].message.content).toBe('2+2 equals 4.');

      // 6. 用户响应适配：Internal → OpenAICompat（从 GatewayContext 组装）
      const ctx: GatewayContext = {
        id: 'gateway-uuid-001',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'gpt-4',
        route: {
          model: 'deepseek-chat',
          modelType: 'chat',
          providerKind: 'deepseek',
          providerId: 'abc12345',
          providerConfig: {
            id: 'abc12345',
            kind: 'deepseek',
            name: 'DeepSeek',
            apiKey: 'sk-test',
            baseUrl: 'https://api.deepseek.com',
            isActive: true,
            config: {},
          },
          strategy: 'load_balance',
          capabilities: [],
        },
        response: internalRes,
        audit: {},
        timing: { start: 1700000000000 },
      };

      const responseAdapter = new OpenAICompatChatResponseAdapter();
      const userRes = responseAdapter.fromInternal(ctx);

      // 验证最终用户响应
      expect(userRes.id).toBe('gateway-uuid-001');
      expect(userRes.object).toBe('chat.completion');
      expect(userRes.created).toBe(1700000000);
      expect(userRes.model).toBe('gpt-4');
      expect(userRes.choices[0].message.content).toBe('2+2 equals 4.');
      expect(userRes.usage.total_tokens).toBe(33);
    });
  });
});

import type {
  ModelHttpContext,
  InternalChatRequest,
  InternalChatResponse,
  InternalEmbeddingRequest,
  InternalEmbeddingResponse,
  InternalMessage,
  ToolCall,
  ToolDefinition,
} from '../index';

describe('Internal Types', () => {
  describe('ModelHttpContext', () => {
    it('should accept a minimal valid context', () => {
      const ctx: ModelHttpContext = {
        id: 'test-id-123',
        ip: '127.0.0.1',
        http: { method: 'POST', path: '/model/openai-compat/v1/chat/completions' },
        userFormat: 'openaicompat',
        requestModel: 'gpt-4',
        audit: {},
        timing: { start: Date.now() },
      };

      expect(ctx.id).toBe('test-id-123');
      expect(ctx.ip).toBe('127.0.0.1');
      expect(ctx.requestModel).toBe('gpt-4');
      expect(ctx.route).toBeUndefined();
      expect(ctx.request).toBeUndefined();
      expect(ctx.response).toBeUndefined();
      expect(ctx.error).toBeUndefined();
    });

    it('should accept a fully populated context', () => {
      const ctx: ModelHttpContext = {
        id: 'req-001',
        ip: '192.168.1.1',
        apiKey: 'sk-test-key',
        http: { method: 'POST', path: '/model/openai-compat/v1/chat/completions', userAgent: 'test-client' },
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

            credential: { type: 'api_key', key: 'sk-test' },
            baseUrl: 'https://api.deepseek.com',

            config: {
              custom_headers: {},
              http_proxy: undefined,
            } as unknown as import('../index').ProviderAdvancedConfig,
          },
          strategy: 'load_balance',
          capabilities: [],
        },
        request: {
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        },
        response: {
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi!' },
              finish_reason: 'stop',
            },
          ],
        },
        stream: false,
        audit: {
          userRequest: { body: { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] } },
        },
        error: undefined,
        timing: {
          start: 1000,
          routed: 1005,
          providerStart: 1010,
          providerEnd: 1500,
          end: 1510,
        },
      };

      expect(ctx.route?.model).toBe('deepseek-chat');
      expect(ctx.route?.modelType).toBe('chat');
      expect(ctx.route?.providerId).toBe('abc12345');
      expect((ctx.timing.providerEnd ?? 0) - (ctx.timing.providerStart ?? 0)).toBe(490);
    });
  });

  describe('InternalChatRequest', () => {
    it('should accept a minimal chat request (no model field)', () => {
      const req: InternalChatRequest = {
        messages: [{ role: 'user', content: 'What is 1+1?' }],
        stream: false,
      };

      expect(req.messages).toHaveLength(1);
      expect(req.stream).toBe(false);
      // InternalChatRequest should NOT have a model field
      expect((req as unknown as Record<string, unknown>).model).toBeUndefined();
    });

    it('should support all optional generation parameters', () => {
      const req: InternalChatRequest = {
        messages: [{ role: 'user', content: 'test' }],
        stream: false,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 50,
        max_tokens: 4096,
        stop: ['\n', '###'],
        presence_penalty: 0.5,
        frequency_penalty: -0.2,
      };

      expect(req.temperature).toBe(0.7);
      expect(req.top_k).toBe(50);
      expect(req.stop).toEqual(['\n', '###']);
    });

    it('should support thinking configuration', () => {
      const req: InternalChatRequest = {
        messages: [{ role: 'user', content: 'Think deeply' }],
        stream: false,
        thinking: {
          type: 'enabled',
          budget_tokens: 8192,
        },
      };

      expect(req.thinking?.budget_tokens).toBe(8192);
      expect(req.thinking?.budget_tokens).toBe(8192);
    });

    it('should support tool definitions and tool_choice', () => {
      const tool: ToolDefinition = {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather info',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      };

      const req: InternalChatRequest = {
        messages: [{ role: 'user', content: 'What is the weather?' }],
        stream: false,
        tools: [tool],
        tool_choice: 'auto',
      };

      expect(req.tools).toHaveLength(1);
      expect(req.tool_choice).toBe('auto');
    });

    it('should support multimodal content in messages', () => {
      const msg: InternalMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', url: 'https://example.com/image.png' },
        ],
      };

      expect(Array.isArray(msg.content)).toBe(true);
      if (Array.isArray(msg.content)) {
        expect(msg.content).toHaveLength(2);
        expect(msg.content[0]?.type).toBe('text');
        expect(msg.content[1]?.type).toBe('image');
      }
    });

    it('should support tool call messages', () => {
      const toolCall: ToolCall = {
        id: 'call_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
      };

      const assistantMsg: InternalMessage = {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall],
      };

      const toolMsg: InternalMessage = {
        role: 'tool',
        content: '{"temp": 25}',
        tool_call_id: 'call_123',
      };

      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(toolMsg.tool_call_id).toBe('call_123');
    });
  });

  describe('InternalChatResponse', () => {
    it('should accept a valid response (no id/model/created)', () => {
      const res: InternalChatResponse = {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello world!' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      expect(res.choices).toHaveLength(1);
      expect(res.choices[0]?.finish_reason).toBe('stop');
      expect(res.usage?.total_tokens).toBe(15);
      // Should NOT have id/model/created
      expect((res as unknown as Record<string, unknown>).id).toBeUndefined();
      expect((res as unknown as Record<string, unknown>).model).toBeUndefined();
      expect((res as unknown as Record<string, unknown>).created).toBeUndefined();
    });

    it('should support reasoning_content in response', () => {
      const res: InternalChatResponse = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'Let me think step by step...',
            },
            finish_reason: 'stop',
          },
        ],
      };

      expect(res.choices[0]?.message.reasoning_content).toBeDefined();
    });

    it('should support extended usage with reasoning_tokens', () => {
      const res: InternalChatResponse = {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300,
          reasoning_tokens: 50,
          cached_tokens: 80,
        },
      };

      expect(res.usage?.reasoning_tokens).toBe(50);
      expect(res.usage?.cached_tokens).toBe(80);
    });
  });

  describe('InternalEmbeddingRequest', () => {
    it('should accept single text input as array (no model field)', () => {
      const req: InternalEmbeddingRequest = {
        input: [{ type: 'text', text: 'Hello world' }],
      };

      expect(req.input).toHaveLength(1);
      expect(req.input[0]).toEqual({ type: 'text', text: 'Hello world' });
      expect((req as unknown as Record<string, unknown>).model).toBeUndefined();
    });

    it('should accept multiple text inputs with dimensions', () => {
      const req: InternalEmbeddingRequest = {
        input: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
        encoding_format: 'float',
        dimensions: 1536,
      };

      expect(req.input).toHaveLength(2);
      expect(req.dimensions).toBe(1536);
    });

    it('should accept multimodal inputs (text + image + video)', () => {
      const req: InternalEmbeddingRequest = {
        input: [
          { type: 'text', text: 'A cat sitting on a mat' },
          { type: 'image', url: 'https://example.com/cat.jpg' },
          { type: 'video', url: 'https://example.com/cat.mp4' },
        ],
        dimensions: 1024,
      };

      expect(req.input).toHaveLength(3);
      expect(req.input[0]).toEqual({ type: 'text', text: 'A cat sitting on a mat' });
      expect(req.input[1]).toEqual({ type: 'image', url: 'https://example.com/cat.jpg' });
      expect(req.input[2]).toEqual({ type: 'video', url: 'https://example.com/cat.mp4' });
    });
  });

  describe('InternalEmbeddingResponse', () => {
    it('should accept a valid embedding response', () => {
      const res: InternalEmbeddingResponse = {
        object: 'embedding',
        embedding: [0.1, 0.2, 0.3],
        usage: {
          prompt_tokens: 10,
          total_tokens: 10,
        },
      };

      expect(res.object).toBe('embedding');
      expect(res.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(res.usage?.prompt_tokens).toBe(10);
    });
  });
});

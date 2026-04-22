/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/only-throw-error, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
// tests/core/engine.test.ts — 核心调度引擎单元测试

import { configManager } from '@/config';
import { clearAllMocks } from '@/tests/helpers/mock-server';
import { GatewayError } from '@/utils/errors';
import { dispatchChatProvider, dispatchChatProviderStream, dispatchEmbeddingProvider } from '../engine';
import { getProviderChatAdapterSet, getProviderEmbeddingAdapterSet } from '../index';

// 模拟 configManager
jest.mock('@/config', () => ({
  configManager: {
    resolveAllBackends: jest.fn(),
  },
}));

jest.mock('../index', () => ({
  getProviderChatAdapterSet: jest.fn(),
  getProviderEmbeddingAdapterSet: jest.fn(),
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  parseSSEStream: async function* () {
    await Promise.resolve();
    yield '{"test":"val"}';
    yield '{"some":"chunk"}';
    yield 'invalid-json'; // Should skip
  },
}));

describe('Core Engine: dispatch', () => {
  const mockExecutor = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    clearAllMocks();
    jest.clearAllMocks();
    mockExecutor.mockClear();
  });

  it('should correctly dispatch chat request with provided route', async () => {
    const mockContext = {
      id: 'test-req-id',
      requestModel: 'deepseek-chat',
      route: {
        providerKind: 'deepseek',
        model: 'ds-chat',
        providerId: 'ds-1',
        providerConfig: { apiKey: 'key' },
        strategy: 'load_balance',
        capabilities: [],
      },
      audit: {},
      timing: {},
      response: {},
    } as unknown as import('@/types').RoutedModelHttpContext;

    await dispatchChatProvider(
      mockContext,
      { messages: [] } as unknown as import('@/types').InternalChatRequest,
      mockExecutor,
    );

    expect(mockContext.route.model).toBe('ds-chat');
    expect(mockContext.route.providerKind).toBe('deepseek');
    expect(mockExecutor).toHaveBeenCalled();
  });

  it('should propagate error thrown by executor', async () => {
    const mockContext = {
      id: 'no-backend-id',
      requestModel: 'unknown-model',
      route: {
        providerKind: 'deepseek',
        model: 'ds-chat',
        strategy: 'load_balance',
        capabilities: [],
      },
      audit: {},
      timing: {},
      response: {},
    } as unknown as import('@/types').RoutedModelHttpContext;

    mockExecutor.mockRejectedValue(new GatewayError(503, 'no_available_backend', 'No backends'));

    await expect(
      dispatchChatProvider(
        mockContext,
        { messages: [] } as unknown as import('@/types').InternalChatRequest,
        mockExecutor,
      ),
    ).rejects.toThrow(GatewayError);
  });

  it('should assign GatewayError providerDetail to ctx.providerError and throw', async () => {
    const mockContext = {
      id: 't',
      requestModel: 'm',
      audit: {},
      timing: {},
      response: {},
      route: { capabilities: [] },
    } as unknown as import('@/types').RoutedModelHttpContext;
    const gwErr2: GatewayError = new GatewayError(400, 'err', 'msg', { isDetail: true } as any);
    mockExecutor.mockRejectedValue(gwErr2);

    await expect(dispatchChatProvider(mockContext, {} as any, mockExecutor)).rejects.toThrow(GatewayError);
    expect(mockContext.providerError).toEqual({ isDetail: true });
  });

  it('should handle TimeoutError uniquely', async () => {
    const mockContext = {
      id: 't',
      requestModel: 'm',
      audit: {},
      timing: {},
      response: {},
      route: { capabilities: [] },
    } as unknown as import('@/types').RoutedModelHttpContext;
    const err = new Error('time');
    err.name = 'TimeoutError';
    mockExecutor.mockRejectedValue(err);

    await expect(dispatchChatProvider(mockContext, {} as any, mockExecutor)).rejects.toThrow(/timed out/);
  });

  it('should sanitize generic errors and return 502', async () => {
    const mockContext = {
      id: 't',
      requestModel: 'm',
      audit: {},
      timing: {},
      response: {},
      route: { capabilities: [] },
    } as unknown as import('@/types').RoutedModelHttpContext;
    mockExecutor.mockRejectedValue(new Error('DeepSeek API returned 400: actual error payload'));

    try {
      await dispatchChatProvider(mockContext, {} as any, mockExecutor);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      expect(e.statusCode).toBe(502);
      expect(e.message).toBe('actual error payload'); // The regex substitution
    }
  });

  it('should directly callProvider adapting and dispatching', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ requestHeaders: {}, responseHeaders: {}, body: {} }) };
    const getAdapterSet = jest.fn().mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn().mockReturnValue({ body: 'test' }) },
      responseAdapter: { fromProviderResponse: jest.fn().mockReturnValue({ res: 'test' }) },
      client: mockClient,
    });

    const mockCtx = {
      id: '1',
      route: { providerKind: 'deepseek', model: 'my-model', providerConfig: {} },
      audit: {},
      timing: {},
    } as any;

    const { callProvider } = jest.requireActual('../engine');
    await callProvider(mockCtx, { input: [] }, getAdapterSet, 'TestLabel');
    expect(mockClient.call).toHaveBeenCalled();
    expect(mockCtx.response).toEqual({ res: 'test' });
  });
});

describe('Core Engine: dispatchEmbedding', () => {
  it('should invoke embedding specific adapters', async () => {
    const mockClient = { call: jest.fn().mockResolvedValue({ requestHeaders: {}, responseHeaders: {}, body: {} }) };
    (getProviderEmbeddingAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn().mockReturnValue({}) },
      responseAdapter: { fromProviderResponse: jest.fn().mockReturnValue({}) },
      client: mockClient,
    });

    const mockCtx = {
      id: '1',
      requestModel: 'foo',
      route: { providerKind: 'deepseek', model: 'my-model', providerConfig: {}, capabilities: [] },
      audit: {},
      timing: {},
    } as unknown as import('@/types').RoutedModelHttpContext;

    await dispatchEmbeddingProvider(mockCtx, { input: [] } as any);
    expect(mockClient.call).toHaveBeenCalled();
  });
});

describe('Core Engine: dispatchStream', () => {
  it('should successfully stream chat', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

    const mockClient = {
      callStream: jest.fn().mockResolvedValue({
        requestHeaders: {},
        response: {
          headers: new Headers(),
          body: true, // triggers stream parse mock
        },
      }),
    };
    const mockAdapter = {
      fromProviderStreamChunk: jest.fn().mockImplementation((chunk) => chunk),
    };

    (getProviderChatAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn() },
      streamResponseAdapter: mockAdapter,
      client: mockClient,
    });

    const mockCtx = {
      id: 'stream-req-id',
      requestModel: 'foo',
      route: { capabilities: [] },
      audit: {},
      timing: {},
    } as unknown as import('@/types').RoutedModelHttpContext;

    const { stream } = await dispatchChatProviderStream(mockCtx, {} as any);
    const chunks = [];
    for await (const ch of stream) {
      chunks.push(ch);
    }
    expect(chunks.length).toBe(2); // The valid JSON elements from the parseSSEStream mock
    expect(mockCtx.id).toBe('stream-req-id');
  });

  it('should throw immediately if no available candidates', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([]);
    const mockCtx = {
      requestModel: 'foo',
      route: { capabilities: [] },
      audit: {},
      timing: {},
    } as unknown as import('@/types').RoutedModelHttpContext;
    await expect(dispatchChatProviderStream(mockCtx, {} as any)).rejects.toThrow(/No available chat backends/);
  });

  it('should safely map inner errors for streams', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

    const gwErr = new GatewayError(400, 'e', 'test', { detail: true } as any);

    (getProviderChatAdapterSet as jest.Mock).mockImplementation(() => {
      throw gwErr;
    });

    const mockCtx = {
      id: 'xyz',
      requestModel: 'foo',
      route: { capabilities: [] },
      audit: {},
      timing: {},
    } as unknown as import('@/types').RoutedModelHttpContext;
    await expect(dispatchChatProviderStream(mockCtx, {} as any)).rejects.toThrow(GatewayError);
    expect(mockCtx.providerError).toEqual({ detail: true });
  });

  it('should handle TimeoutError uniquely in stream', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);
    const err = new Error('time');
    err.name = 'TimeoutError';
    (getProviderChatAdapterSet as jest.Mock).mockImplementation(() => {
      throw err;
    });
    const mockCtx = { requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;
    await expect(dispatchChatProviderStream(mockCtx, {} as any)).rejects.toThrow(/timed out/);
  });

  it('should sanitize generic errors and return 502 in stream', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);
    (getProviderChatAdapterSet as jest.Mock).mockImplementation(() => {
      throw new Error('DeepSeek API returned 500: bad');
    });
    const mockCtx = { requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;
    try {
      await dispatchChatProviderStream(mockCtx, {} as any);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      expect(e.statusCode).toBe(502);
      expect(e.message).toBe('bad');
    }
  });

  it('should skip reading stream response if body is falsy', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);
    const mockClient = {
      callStream: jest.fn().mockResolvedValue({
        requestHeaders: {},
        response: { headers: new Headers(), body: null },
      }),
    };
    (getProviderChatAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn() },
      streamResponseAdapter: {},
      client: mockClient,
    });

    const mockCtx = {
      requestModel: 'foo',
      route: { capabilities: [] },
      audit: {},
      timing: { providerStart: 100 },
    } as unknown as import('@/types').RoutedModelHttpContext; // mock defined providerStart
    const { stream } = await dispatchChatProviderStream(mockCtx, {} as any);
    const chunks = [];
    for await (const ch of stream) {
      chunks.push(ch);
    }
    expect(chunks.length).toBe(0);
  });

  it('should catch chunk parse errors gracefully and handle non-Error throws', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);
    const mockClient = {
      callStream: jest.fn().mockResolvedValue({
        requestHeaders: {},
        response: { headers: new Headers(), body: true },
      }),
    };
    (getProviderChatAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn() },
      streamResponseAdapter: {
        fromProviderStreamChunk: jest.fn().mockImplementation(() => {
          throw 'string throw instead of Error'; // hits String(error)
        }),
      },
      client: mockClient,
    });

    const mockCtx = { id: 'test', requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;
    const { stream } = await dispatchChatProviderStream(mockCtx, {} as any);
    const chunks = [];
    for await (const ch of stream) {
      chunks.push(ch);
    }
    expect(chunks.length).toBe(0); // All chunks from mock stream threw errors and were caught
  });

  it('should handle non-Error objects in dispatch exceptions (covers String(error) branches)', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'pk' }]);

    const objErr = { myerr: 123 };
    (getProviderChatAdapterSet as jest.Mock).mockImplementation(() => {
      throw objErr;
    });

    const mockCtx = { id: 'xyz', requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;
    await expect(dispatchChatProviderStream(mockCtx, {} as any)).rejects.toThrow(/\[object Object\]/);

    const mockExecutor = jest.fn().mockRejectedValue(objErr);
    await expect(dispatchChatProvider(mockCtx, {} as any, mockExecutor)).rejects.toThrow(/\[object Object\]/);
  });

  it('should use default executor in dispatchChatProvider if not provided', async () => {
    // Setup minimal passing case for default executor (callProvider)
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'deepseek' }]);
    (getProviderChatAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn().mockReturnValue({}) },
      responseAdapter: { fromProviderResponse: jest.fn().mockReturnValue({}) },
      client: { call: jest.fn().mockResolvedValue({ requestHeaders: {}, responseHeaders: {}, body: {} }) },
    });
    const mockCtx = { id: 'xyz', requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;

    // We aren't testing functionality again, just covering the default parameter assignment branch
    await expect(dispatchChatProvider(mockCtx, {} as any)).resolves.not.toThrow();
  });

  it('should use default executor in dispatchEmbeddingProvider if not provided', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([{ actualModel: 'am', providerKind: 'deepseek' }]);
    (getProviderEmbeddingAdapterSet as jest.Mock).mockReturnValue({
      requestAdapter: { toProviderRequest: jest.fn().mockReturnValue({}) },
      responseAdapter: { fromProviderResponse: jest.fn().mockReturnValue({}) },
      client: { call: jest.fn().mockResolvedValue({ requestHeaders: {}, responseHeaders: {}, body: {} }) },
    });
    const mockCtx = { id: 'xyz', requestModel: 'foo', route: { capabilities: [] }, audit: {}, timing: {} } as any;
    await expect(dispatchEmbeddingProvider(mockCtx, {} as any)).resolves.not.toThrow();
  });

  it('should sanitizeProviderError properly if stripped is empty string', async () => {
    // "DeepSeek API returned 400: " will strip entirely, exposing fallback "Provider request failed"
    const mockContext = {
      id: 't',
      requestModel: 'm',
      audit: {},
      timing: {},
      response: {},
      route: { capabilities: [] },
    } as any;
    const mockExecutor = jest.fn().mockRejectedValue(new Error('DeepSeek API returned 400: '));

    try {
      await dispatchChatProvider(mockContext, {} as any, mockExecutor);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      expect(e.message).toBe('Provider request failed');
    }
  });
});

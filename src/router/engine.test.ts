// tests/core/engine.test.ts — 核心调度引擎单元测试

import { clearAllMocks } from '@/tests/helpers/mock-server';
import { GatewayError } from '@/utils/errors';
import { configManager } from '../config';
import { dispatchChatProvider } from '../providers/engine';

// 模拟 configManager
jest.mock('../config', () => ({
  configManager: {
    resolveAllBackends: jest.fn(),
  },
}));

describe('Core Engine: dispatch', () => {
  const mockExecutor = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    clearAllMocks();
    jest.clearAllMocks();
    mockExecutor.mockClear();
  });

  it('should correctly dispatch chat request and resolve backend', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([
      {
        actualModel: 'ds-chat',
        providerKind: 'deepseek',
        providerId: 'ds-1',
        provider: { apiKey: 'key' },
      },
    ]);

    const mockContext = {
      id: 'test-req-id',
      requestModel: 'deepseek-chat',
      route: {}, // 初始为空
      audit: {},
      timing: {},
      response: {},
    } as unknown as import('@/types').GatewayContext;

    await dispatchChatProvider(
      mockContext,
      { messages: [] } as unknown as import('@/types').InternalChatRequest,
      mockExecutor,
    );

    expect(mockContext.route?.model).toBe('ds-chat');
    expect(mockContext.route?.providerKind).toBe('deepseek');
    expect(mockExecutor).toHaveBeenCalled();
  });

  it('should skip backend resolution if route is already populated', async () => {
    const mockContext = {
      id: 'test-req-id',
      requestModel: 'deepseek-chat',
      route: {
        providerKind: 'gemini',
        model: 'gemini-1.5',
        capabilities: { chat: true },
      },
      audit: {},
      timing: {},
      response: {},
    } as unknown as import('@/types').GatewayContext;

    await dispatchChatProvider(
      mockContext,
      { messages: [] } as unknown as import('@/types').InternalChatRequest,
      mockExecutor,
    );

    expect(configManager.resolveAllBackends).not.toHaveBeenCalled();
    expect(mockExecutor).toHaveBeenCalled();
  });

  it('should throw GatewayError when no backends are available', async () => {
    (configManager.resolveAllBackends as jest.Mock).mockReturnValue([]);

    const mockContext = {
      id: 'no-backend-id',
      requestModel: 'unknown-model',
      route: {},
      audit: {},
      timing: {},
      response: {},
    } as unknown as import('@/types').GatewayContext;

    await expect(
      dispatchChatProvider(
        mockContext,
        { messages: [] } as unknown as import('@/types').InternalChatRequest,
        mockExecutor,
      ),
    ).rejects.toThrow(GatewayError);
  });
});

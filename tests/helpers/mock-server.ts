// tests/helpers/mock-server.ts — 集成测试的 Mock 服务器辅助函数

import type { GatewayContext } from '@/types';
import type { ConfigManager } from '@/config/manager';

/**
 * 创建测试用的 GatewayContext
 */
export function createMockContext(overrides: Partial<GatewayContext> = {}): GatewayContext {
  return {
    requestId: 'test-request-id',
    virtualModel: 'test-model',
    backend: {
      actualModel: 'test-backend-model',
      modelType: 'chat',
      provider: {
        kind: 'deepseek',
        name: 'Test Provider',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.test.com',
      },
    },
    routingStrategy: 'simple',
    ...overrides,
  };
}

/**
 * 创建 Mock ConfigManager
 */
export function createMockConfigManager(): jest.Mocked<ConfigManager> {
  return {
    loadAll: jest.fn(),
    getVirtualModelConfig: jest.fn(),
    getAllVirtualModels: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  } as unknown as jest.Mocked<ConfigManager>;
}

/**
 * 清除所有 Mock
 */
export function clearAllMocks(): void {
  jest.clearAllMocks();
}

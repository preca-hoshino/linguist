// tests/core/registry.test.ts — 插件注册中心单元测试

import { getProviderChatAdapterSet, getProviderPlugin, registerPlugin } from '../index';

describe('Core: Plugin Registry', () => {
  it('should register and retrieve a custom plugin', () => {
    const mockPlugin = {
      kind: 'mock-p',
      getChatAdapterSet: jest.fn().mockReturnValue({}),
      mapError: jest.fn(),
    } as unknown as import('@/providers/types').ProviderPlugin;

    registerPlugin(mockPlugin);

    const retrieved = getProviderPlugin('mock-p');
    expect(retrieved).toBe(mockPlugin);
  });

  it('should assemble adapter sets for known plugins', () => {
    const config = { id: 'p1', kind: 'deepseek', name: 'DS', apiKey: 'k', baseUrl: 'b', config: {} };
    const set = getProviderChatAdapterSet('deepseek', config as unknown as import('@/types').ProviderConfig);

    expect(set.client).toBeDefined();
    expect(set.requestAdapter).toBeDefined();
  });

  it('should throw for unregistered plugins', () => {
    expect(() => getProviderPlugin('ghost')).toThrow('Unknown provider: ghost');
  });
});

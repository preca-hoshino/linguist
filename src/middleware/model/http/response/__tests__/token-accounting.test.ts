import { configManager } from '@/config';
import type { ModelHttpContext } from '@/types';
import { rateLimiter } from '@/utils';
import { tokenAccounting } from '../token-accounting';

jest.mock('@/config', () => ({
  configManager: {
    getVirtualModelConfig: jest.fn(),
  },
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
  rateLimiter: {
    incrementTpm: jest.fn(),
    incrementRpm: jest.fn(),
    isRpmFull: jest.fn(),
    isTpmFull: jest.fn(),
  },
}));

describe('tokenAccounting middleware', () => {
  const mockVmConfig = {
    id: 'vm-1',
    backends: [
      {
        actualModel: 'real-model',
        provider: { id: 'prov-1' },
        providerModelId: 'pm-1',
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue(mockVmConfig);
  });

  it('should return early when ctx.response is undefined', () => {
    const ctx = { response: undefined, requestModel: 'my-model' } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).not.toHaveBeenCalled();
  });

  it('should return early when usage.total_tokens is 0', () => {
    const ctx = {
      requestModel: 'my-model',
      response: { usage: { total_tokens: 0 } },
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).not.toHaveBeenCalled();
  });

  it('should return early when response has no usage field', () => {
    const ctx = {
      requestModel: 'my-model',
      response: { choices: [] },
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).not.toHaveBeenCalled();
  });

  it('should return early when vmConfig is not found', () => {
    (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue(undefined);
    const ctx = {
      requestModel: 'unknown-model',
      response: { usage: { total_tokens: 100 } },
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).not.toHaveBeenCalled();
  });

  it('should increment vm TPM when tokens > 0 and no route', () => {
    const ctx = {
      id: 'req-1',
      requestModel: 'my-model',
      response: { usage: { total_tokens: 500 } },
      route: undefined,
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledWith('vm', 'vm-1', 500);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledTimes(1);
  });

  it('should increment vm and pm TPM when route matches a backend', () => {
    const ctx = {
      id: 'req-1',
      requestModel: 'my-model',
      response: { usage: { total_tokens: 300 } },
      route: { model: 'real-model', providerId: 'prov-1' },
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledWith('vm', 'vm-1', 300);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledWith('pm', 'pm-1', 300);
  });

  it('should skip pm TPM when backend not found in vmConfig', () => {
    const ctx = {
      id: 'req-1',
      requestModel: 'my-model',
      response: { usage: { total_tokens: 200 } },
      route: { model: 'unknown-model', providerId: 'prov-1' },
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledWith('vm', 'vm-1', 200);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledTimes(1);
  });

  it('should extract tokens from embedding response (usage.total_tokens)', () => {
    const ctx = {
      id: 'req-1',
      requestModel: 'my-model',
      response: { usage: { total_tokens: 150, prompt_tokens: 150 } },
      route: undefined,
    } as unknown as ModelHttpContext;
    tokenAccounting(ctx);
    expect(rateLimiter.incrementTpm).toHaveBeenCalledWith('vm', 'vm-1', 150);
  });
});

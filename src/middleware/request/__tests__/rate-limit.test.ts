/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { configManager } from '@/config';
import type { GatewayContext } from '@/types';
import { GatewayError, rateLimiter } from '@/utils';
import { rateLimit } from '../rate-limit';

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
    isRpmFull: jest.fn(),
    isTpmFull: jest.fn(),
    incrementRpm: jest.fn(),
    incrementTpm: jest.fn(),
  },
}));

describe('rateLimit middleware', () => {
  const mockVmConfig = {
    id: 'vm-1',
    rpmLimit: 60,
    tpmLimit: 100000,
    backends: [
      {
        actualModel: 'real-model',
        provider: { id: 'prov-1' },
        providerModelId: 'pm-1',
      },
    ],
  };

  let mockCtx: Partial<GatewayContext>;

  beforeEach(() => {
    mockCtx = {
      id: 'req-1',
      requestModel: 'my-model',
      route: {
        model: 'real-model',
        providerId: 'prov-1',
      } as any,
    };
    jest.clearAllMocks();
    (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue(mockVmConfig);
    (rateLimiter.isRpmFull as jest.Mock).mockReturnValue(false);
    (rateLimiter.isTpmFull as jest.Mock).mockReturnValue(false);
  });

  it('should return early if vmConfig is not found', () => {
    (configManager.getVirtualModelConfig as jest.Mock).mockReturnValue(undefined);
    expect(() => {
      rateLimit(mockCtx as GatewayContext);
    }).not.toThrow();
    expect(rateLimiter.incrementRpm).not.toHaveBeenCalled();
  });

  it('should throw 429 when RPM limit exceeded', () => {
    (rateLimiter.isRpmFull as jest.Mock).mockReturnValue(true);
    expect(() => {
      rateLimit(mockCtx as GatewayContext);
    }).toThrow(GatewayError);
    try {
      rateLimit(mockCtx as GatewayContext);
    } catch (err: unknown) {
      const e = err as GatewayError;
      expect(e.statusCode).toBe(429);
      expect(e.errorCode).toBe('rate_limit_exceeded');
    }
  });

  it('should throw 429 when TPM limit exceeded', () => {
    (rateLimiter.isTpmFull as jest.Mock).mockReturnValue(true);
    expect(() => {
      rateLimit(mockCtx as GatewayContext);
    }).toThrow(GatewayError);
    try {
      rateLimit(mockCtx as GatewayContext);
    } catch (err: unknown) {
      const e = err as GatewayError;
      expect(e.statusCode).toBe(429);
    }
  });

  it('should increment RPM for vm and pm when backend is found', () => {
    rateLimit(mockCtx as GatewayContext);
    expect(rateLimiter.incrementRpm).toHaveBeenCalledWith('vm', 'vm-1');
    expect(rateLimiter.incrementRpm).toHaveBeenCalledWith('pm', 'pm-1');
  });

  it('should skip pm RPM increment when ctx.route is undefined', () => {
    (mockCtx as any).route = undefined;
    rateLimit(mockCtx as GatewayContext);
    expect(rateLimiter.incrementRpm).toHaveBeenCalledWith('vm', 'vm-1');
    expect(rateLimiter.incrementRpm).toHaveBeenCalledTimes(1); // only vm
  });

  it('should skip pm RPM increment when backend is not found in vmConfig', () => {
    mockCtx.route = { model: 'unknown-model', providerId: 'prov-1' } as any;
    rateLimit(mockCtx as GatewayContext);
    expect(rateLimiter.incrementRpm).toHaveBeenCalledWith('vm', 'vm-1');
    expect(rateLimiter.incrementRpm).toHaveBeenCalledTimes(1);
  });
});

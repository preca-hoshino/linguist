import { validateApiKey } from '@/db/api-keys';
import type { GatewayContext } from '@/types';
import { GatewayError } from '@/utils';
import { apiKeyAuth } from './api-key-auth';

jest.mock('@/db/api-keys', () => ({
  validateApiKey: jest.fn(),
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

describe('apiKeyAuth middleware', () => {
  let mockCtx: Partial<GatewayContext>;

  beforeEach(() => {
    mockCtx = {
      id: 'req-123',
      ip: '127.0.0.1',
      apiKey: 'sk-test12345678',
      userFormat: 'openaicompat',
    };
    process.env.REQUIRE_API_KEY = 'true';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.REQUIRE_API_KEY;
  });

  it('should skip validation if REQUIRE_API_KEY is false', async () => {
    process.env.REQUIRE_API_KEY = 'false';
    await apiKeyAuth(mockCtx as GatewayContext);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('should throw 401 if apiKey is missing', async () => {
    mockCtx.apiKey = '';
    await expect(apiKeyAuth(mockCtx as GatewayContext)).rejects.toThrow(GatewayError);
  });

  it('should throw 401 with gemini hint if userFormat is gemini and apiKey is missing', async () => {
    mockCtx.apiKey = '';
    mockCtx.userFormat = 'gemini';
    await expect(apiKeyAuth(mockCtx as GatewayContext)).rejects.toThrow(GatewayError);
  });

  it('should throw 401 if api key is invalid or inactive', async () => {
    (validateApiKey as jest.Mock).mockResolvedValue(null);
    await expect(apiKeyAuth(mockCtx as GatewayContext)).rejects.toThrow(GatewayError);
    expect(validateApiKey).toHaveBeenCalledWith('sk-test12345678');
  });

  it('should set apiKeyName and pass if key is valid', async () => {
    (validateApiKey as jest.Mock).mockResolvedValue({ name: 'My App Key' });

    await apiKeyAuth(mockCtx as GatewayContext);

    expect(validateApiKey).toHaveBeenCalledWith('sk-test12345678');
    expect(mockCtx.apiKeyName).toBe('My App Key');
  });
});

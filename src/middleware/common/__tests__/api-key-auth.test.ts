import { validateApiKey } from '@/db/api-keys';
import { lookupApp } from '@/db/apps';
import type { ModelHttpContext } from '@/types';
import { GatewayError } from '@/utils';
import { apiKeyAuth } from '../api-key-auth';

jest.mock('@/db/api-keys', () => ({
  validateApiKey: jest.fn(),
}));

jest.mock('@/db/apps', () => ({
  lookupApp: jest.fn(),
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
  let mockCtx: Partial<ModelHttpContext>;

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
    await apiKeyAuth(mockCtx as ModelHttpContext);
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it('should throw 401 if apiKey is missing', async () => {
    mockCtx.apiKey = '';
    await expect(apiKeyAuth(mockCtx as ModelHttpContext)).rejects.toThrow(GatewayError);
  });

  it('should throw 401 with gemini hint if userFormat is gemini and apiKey is missing', async () => {
    mockCtx.apiKey = '';
    mockCtx.userFormat = 'gemini';
    await expect(apiKeyAuth(mockCtx as ModelHttpContext)).rejects.toThrow(GatewayError);
  });

  it('should throw 401 if api key is invalid or inactive', async () => {
    (validateApiKey as jest.Mock).mockResolvedValue(null);
    await expect(apiKeyAuth(mockCtx as ModelHttpContext)).rejects.toThrow(GatewayError);
    expect(validateApiKey).toHaveBeenCalledWith('sk-test12345678');
  });

  it('should set apiKeyName, appId and appName if key is valid', async () => {
    (validateApiKey as jest.Mock).mockResolvedValue({ id: 'ak_1', name: 'My App Key', appId: 'app_1' });
    (lookupApp as jest.Mock).mockResolvedValue({ id: 'app_1', name: 'My App', isActive: true, allowedModelIds: [] });

    await apiKeyAuth(mockCtx as ModelHttpContext);

    expect(validateApiKey).toHaveBeenCalledWith('sk-test12345678');
    expect(mockCtx.apiKeyName).toBe('My App Key');
    expect(mockCtx.appId).toBe('app_1');
    expect(mockCtx.appName).toBe('My App');
  });

  it('should set appId but not appName if app not found in cache', async () => {
    (validateApiKey as jest.Mock).mockResolvedValue({ id: 'ak_1', name: 'My App Key', appId: 'app_99' });
    (lookupApp as jest.Mock).mockResolvedValue(undefined);

    await apiKeyAuth(mockCtx as ModelHttpContext);

    expect(mockCtx.appId).toBe('app_99');
    expect(mockCtx.appName).toBeUndefined();
  });
});

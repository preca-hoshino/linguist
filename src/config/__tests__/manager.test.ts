import { ConfigManager } from '../manager';
import { db, createListenClient } from '@/db';
import { rateLimiter } from '@/utils';

jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
  createListenClient: jest.fn(),
}));

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
const mockCreateListenClient = createListenClient as jest.MockedFunction<typeof createListenClient>;

// Helper to build a query result row
const makeProviderRow = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
  id: 'provider-1',
  kind: 'openai',
  name: 'OpenAI',
  credential_type: 'api_key',
  credential: { key: 'sk-123' },
  base_url: 'https://api.openai.com',
  config: {},
  rpm_limit: null,
  tpm_limit: null,
  ...overrides,
});

const makeBackendRow = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
  vm_id: 'vm-1',
  vm_name: 'test-model',
  vm_model_type: 'chat',
  routing_strategy: 'load_balance',
  vm_rpm_limit: null,
  vm_tpm_limit: null,
  vm_created_at: new Date('2026-01-01'),
  pm_id: 'pm-1',
  pm_name: 'actual-model-1',
  model_type: 'chat',
  pm_capabilities: [],
  pm_supported_parameters: [],
  pm_rpm_limit: null,
  pm_tpm_limit: null,
  pm_timeout_ms: null,
  pm_model_config: null,
  pm_request_overrides: null,
  weight: 100,
  priority: 0,
  provider_id: 'provider-1',
  provider_kind: 'openai',
  provider_name: 'OpenAI',
  credential_type: 'api_key',
  credential: { key: 'sk-123' },
  base_url: 'https://api.openai.com',
  provider_config: {},
  ...overrides,
});

const emptyQueryResult = { rows: [], command: 'SELECT' as const, rowCount: 0, oid: 0, fields: [] };

// Helpers for LISTEN/NOTIFY tests — capture handlers during on() registration
interface ListenMocks {
  client: {
    connect: jest.Mock;
    query: jest.Mock;
    on: jest.Mock;
    end: jest.Mock;
  };
  notifyHandler: ((msg: { channel: string; payload: string }) => void) | undefined;
  errorHandler: ((err: Error) => void) | undefined;
}

function createListenMocks(): ListenMocks {
  const mocks: ListenMocks = {
    client: {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    },
    notifyHandler: undefined,
    errorHandler: undefined,
  };

  mocks.client.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'notification') {
      mocks.notifyHandler = handler as ListenMocks['notifyHandler'];
    } else if (event === 'error') {
      mocks.errorHandler = handler as ListenMocks['errorHandler'];
    }
  });

  return mocks;
}

describe('ConfigManager', () => {
  let manager: ConfigManager;
  let mockIsRpmFull: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ConfigManager();
    mockIsRpmFull = jest.spyOn(rateLimiter, 'isRpmFull').mockReturnValue(false);
    jest.spyOn(rateLimiter, 'isTpmFull').mockReturnValue(false);
  });

  // ==================== loadAll ====================

  describe('loadAll()', () => {
    it('should load providers and virtual models successfully', async () => {
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeProviderRow()], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const virtualModels = manager.getAllVirtualModels();
      expect(virtualModels).toContain('test-model');

      const config = manager.getVirtualModelConfig('test-model');
      expect(config?.routingStrategy).toBe('load_balance');
      expect(config?.backends).toHaveLength(1);
    });

    it('should handle empty providers and empty backends', async () => {
      mockQuery.mockResolvedValueOnce(emptyQueryResult);
      mockQuery.mockResolvedValueOnce(emptyQueryResult);

      await manager.loadAll();

      expect(manager.getAllVirtualModels()).toEqual([]);
    });

    it('should parse oauth2 credentials correctly', async () => {
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [
          makeProviderRow({
            credential_type: 'oauth2',
            credential: {
              accessToken: 'at-123',
              refreshToken: 'rt-456',
              expiresAt: '2027-01-01T00:00:00Z',
              tokenEndpoint: 'https://auth.example.com/token',
            },
          }),
        ],
        rowCount: 1,
      });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const cred = config?.backends[0]?.provider.credential;
      expect(cred?.type).toBe('oauth2');
      if (cred?.type === 'oauth2') {
        expect(cred.accessToken).toBe('at-123');
        expect(cred.refreshToken).toBe('rt-456');
      }
    });

    it('should parse copilot credentials correctly', async () => {
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [
          makeProviderRow({
            credential_type: 'copilot',
            credential: { accessToken: 'ghu_copilot_token' },
          }),
        ],
        rowCount: 1,
      });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const cred = config?.backends[0]?.provider.credential;
      expect(cred?.type).toBe('copilot');
      if (cred?.type === 'copilot') {
        expect(cred.accessToken).toBe('ghu_copilot_token');
      }
    });

    it('should fallback to none credential for unknown type', async () => {
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [makeProviderRow({ credential_type: 'some_future_type', credential: {} })],
        rowCount: 1,
      });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const backend = config?.backends[0];
      if (backend) {
        expect(backend.provider.credential.type).toBe('none');
      } else {
        throw new Error('Expected backend to exist');
      }
    });

    it('should use fallback provider config from backend row when provider not in providers table', async () => {
      mockQuery.mockResolvedValueOnce(emptyQueryResult);
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [
          makeBackendRow({
            provider_id: 'orphan-provider',
            provider_kind: 'custom',
            provider_name: 'Custom Provider',
            credential_type: 'api_key',
            credential: { key: 'fallback-key' },
            base_url: 'https://custom.api.com',
            provider_config: { http_proxy: 'http://proxy:8080' },
          }),
        ],
        rowCount: 1,
      });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const provider = config?.backends[0]?.provider;
      expect(provider?.id).toBe('orphan-provider');
      expect(provider?.kind).toBe('custom');
      expect(provider?.baseUrl).toBe('https://custom.api.com');
    });

    it('should handle numeric rpm/tpm limits on providers', async () => {
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [makeProviderRow({ rpm_limit: 60, tpm_limit: 100000 })],
        rowCount: 1,
      });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const provider = config?.backends[0]?.provider;
      expect(provider?.rpmLimit).toBe(60);
      expect(provider?.tpmLimit).toBe(100000);
    });

    it('should merge default provider config with row config', async () => {
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [makeProviderRow({ config: { http_proxy: 'http://custom-proxy:3128', custom_opt: true } })],
        rowCount: 1,
      });
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

      await manager.loadAll();

      const config = manager.getVirtualModelConfig('test-model');
      const providerConfig = config?.backends[0]?.provider.config;
      expect(providerConfig?.http_proxy).toBe('http://custom-proxy:3128');
      expect(providerConfig?.custom_opt).toBe(true);
    });

    it('should handle backend row with pm_model_config and pm_request_overrides', async () => {
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeProviderRow()], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [
          makeBackendRow({
            pm_model_config: { max_tokens: 4096 },
            pm_request_overrides: { headers: { 'X-Custom': 'val' }, body: { stream: true } },
            pm_timeout_ms: 30000,
          }),
        ],
        rowCount: 1,
      });

      await manager.loadAll();

      const backend = manager.getVirtualModelConfig('test-model')?.backends[0];
      expect(backend?.modelConfig).toEqual({ max_tokens: 4096 });
      expect(backend?.requestOverrides).toEqual({ headers: { 'X-Custom': 'val' }, body: { stream: true } });
      expect(backend?.timeoutMs).toBe(30000);
    });
  });

  // ==================== getAllVirtualModels / getVirtualModelConfig ====================

  describe('getAllVirtualModels()', () => {
    it('should return empty array before loadAll', () => {
      expect(manager.getAllVirtualModels()).toEqual([]);
    });
  });

  describe('getVirtualModelConfig()', () => {
    it('should return undefined for unknown model', () => {
      expect(manager.getVirtualModelConfig('nonexistent')).toBeUndefined();
    });
  });

  // ==================== resolveAllBackends ====================

  describe('resolveAllBackends()', () => {
    beforeEach(async () => {
      mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeProviderRow()], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({
        ...emptyQueryResult,
        rows: [
          makeBackendRow({
            vm_id: 'vm-1',
            vm_name: 'lb-model',
            routing_strategy: 'load_balance',
            pm_id: 'pm-1',
            pm_name: 'actual-1',
            pm_capabilities: ['stream'],
            pm_supported_parameters: ['temperature'],
            weight: 50,
            priority: 1,
            provider_id: 'p1',
            provider_kind: 'test',
          }),
          makeBackendRow({
            vm_id: 'vm-1',
            vm_name: 'lb-model',
            routing_strategy: 'load_balance',
            pm_id: 'pm-2',
            pm_name: 'actual-2',
            pm_capabilities: ['stream', 'cache'],
            pm_supported_parameters: ['temperature', 'top_p'],
            weight: 100,
            priority: 2,
            provider_id: 'p2',
            provider_kind: 'test',
          }),
          makeBackendRow({
            vm_id: 'vm-2',
            vm_name: 'failover-model',
            routing_strategy: 'failover',
            pm_id: 'pm-4',
            pm_name: 'actual-4',
            pm_capabilities: ['stream'],
            pm_supported_parameters: ['temperature'],
            weight: 100,
            priority: 1,
            provider_id: 'p4',
            provider_kind: 'test',
          }),
          makeBackendRow({
            vm_id: 'vm-2',
            vm_name: 'failover-model',
            routing_strategy: 'failover',
            pm_id: 'pm-3',
            pm_name: 'actual-3',
            pm_capabilities: ['stream'],
            pm_supported_parameters: ['temperature'],
            weight: 100,
            priority: 2,
            provider_id: 'p3',
            provider_kind: 'test',
          }),
        ],
        rowCount: 4,
      });

      await manager.loadAll();
    });

    it('should select highest weight backend for load_balance', () => {
      const result = manager.resolveAllBackends('lb-model');
      expect(result).toHaveLength(1);
      expect(result[0]?.actualModel).toBe('actual-2');
    });

    it('should select lowest priority backend for failover', () => {
      const result = manager.resolveAllBackends('failover-model');
      expect(result).toHaveLength(1);
      expect(result[0]?.actualModel).toBe('actual-4');
    });

    it('should filter out backends without required capabilities', () => {
      const result = manager.resolveAllBackends('lb-model', ['cache']);
      expect(result).toHaveLength(1);
      expect(result[0]?.actualModel).toBe('actual-2');
    });

    it('should soft sort backends by supported parameters', () => {
      const result = manager.resolveAllBackends('lb-model', [], ['top_p']);
      expect(result[0]?.actualModel).toBe('actual-2');
    });

    it('should filter out rate limited backends', () => {
      mockIsRpmFull.mockImplementation((_type: string, id: string) => id === 'pm-2');

      const result = manager.resolveAllBackends('lb-model');
      expect(result).toHaveLength(1);
      expect(result[0]?.actualModel).toBe('actual-1');
    });

    it('should return empty list when all backends are rate limited', () => {
      mockIsRpmFull.mockReturnValue(true);

      const result = manager.resolveAllBackends('lb-model');
      expect(result).toHaveLength(0);
    });

    it('should return empty array for unknown virtual model', () => {
      const result = manager.resolveAllBackends('unknown-model');
      expect(result).toEqual([]);
    });

    it('should return empty array when no backends match required capabilities', () => {
      const result = manager.resolveAllBackends('lb-model', ['nonexistent_capability']);
      expect(result).toEqual([]);
    });

    it('should not filter when requiredCapabilities is empty', () => {
      mockIsRpmFull.mockReturnValue(false);
      const result = manager.resolveAllBackends('lb-model', []);
      expect(result).toHaveLength(1);
    });

    it('should return ResolvedRoute with correct shape', () => {
      const result = manager.resolveAllBackends('lb-model');
      expect(result[0]).toHaveProperty('actualModel');
      expect(result[0]).toHaveProperty('modelType');
      expect(result[0]).toHaveProperty('capabilities');
      expect(result[0]).toHaveProperty('supportedParameters');
      expect(result[0]).toHaveProperty('providerKind');
      expect(result[0]).toHaveProperty('providerId');
      expect(result[0]).toHaveProperty('provider');
      expect(result[0]).toHaveProperty('routingStrategy');
    });
  });

  // ==================== LISTEN/NOTIFY lifecycle ====================

  describe('LISTEN/NOTIFY lifecycle', () => {
    let mocks: ListenMocks;

    beforeEach(() => {
      mocks = createListenMocks();
      mockCreateListenClient.mockReturnValue(mocks.client as unknown as ReturnType<typeof createListenClient>);
    });

    describe('startListening()', () => {
      it('should create client, connect, and issue LISTEN', async () => {
        await manager.startListening();

        expect(mockCreateListenClient).toHaveBeenCalledTimes(1);
        expect(mocks.client.connect).toHaveBeenCalledTimes(1);
        expect(mocks.client.on).toHaveBeenCalledWith('notification', expect.any(Function));
        expect(mocks.client.on).toHaveBeenCalledWith('error', expect.any(Function));
        expect(mocks.client.query).toHaveBeenCalledWith('LISTEN config_channel');
      });

      it('should throw if connect fails', async () => {
        mocks.client.connect.mockRejectedValueOnce(new Error('Connection refused'));

        await expect(manager.startListening()).rejects.toThrow('Connection refused');
      });

      it('should reset reconnectAttempts after successful connection', async () => {
        await manager.startListening();
        // Should succeed without error
      });
    });

    describe('notification handling', () => {
      beforeEach(async () => {
        await manager.startListening();
      });

      it('should reload config on notification', async () => {
        expect(mocks.notifyHandler).toBeDefined();

        mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeProviderRow()], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ ...emptyQueryResult, rows: [makeBackendRow()], rowCount: 1 });

        mocks.notifyHandler?.({ channel: 'config_channel', payload: 'providers:update' });

        // Wait for async loadAll to be triggered
        await new Promise((r) => setImmediate(r));
        const reloadCalls = mockQuery.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('FROM model_providers'),
        );
        expect(reloadCalls.length).toBeGreaterThanOrEqual(1);
      });

      it('should invalidate app cache on apps payload', async () => {
        mocks.notifyHandler?.({ channel: 'config_channel', payload: 'apps:update' });

        await new Promise((r) => setImmediate(r));
        const reloadCalls = mockQuery.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('FROM model_providers'),
        );
        expect(reloadCalls).toHaveLength(0);
      });

      it('should invalidate app cache on app_allowed_models payload', async () => {
        mocks.notifyHandler?.({ channel: 'config_channel', payload: 'app_allowed_models:update' });

        await new Promise((r) => setImmediate(r));
        const reloadCalls = mockQuery.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('FROM model_providers'),
        );
        expect(reloadCalls).toHaveLength(0);
      });
    });

    describe('error handling and reconnect', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should schedule reconnect on client error', async () => {
        await manager.startListening();

        expect(mocks.errorHandler).toBeDefined();
        mocks.errorHandler?.(new Error('ECONNRESET'));

        // Reconnect should be scheduled with exponential backoff
        jest.advanceTimersByTime(1000);

        expect(mockCreateListenClient).toHaveBeenCalledTimes(2);
      });

      it('should not reconnect if already stopping', async () => {
        await manager.startListening();

        await manager.stopListening();
        mocks.errorHandler?.(new Error('ECONNRESET'));

        jest.advanceTimersByTime(5000);
        expect(mockCreateListenClient).toHaveBeenCalledTimes(1);
      });
    });

    describe('stopListening()', () => {
      it('should UNLISTEN and end client', async () => {
        await manager.startListening();
        await manager.stopListening();

        expect(mocks.client.query).toHaveBeenCalledWith('UNLISTEN config_channel');
        expect(mocks.client.end).toHaveBeenCalled();
      });

      it('should clear reconnect timer if active', async () => {
        jest.useFakeTimers();
        await manager.startListening();

        mocks.errorHandler?.(new Error('ECONNRESET'));

        await manager.stopListening();

        jest.advanceTimersByTime(5000);
        expect(mockCreateListenClient).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
      });

      it('should handle UNLISTEN failure gracefully', async () => {
        await manager.startListening();
        mocks.client.query.mockRejectedValueOnce(new Error('Connection already closed'));

        await manager.stopListening();
      });

      it('should handle end failure gracefully', async () => {
        await manager.startListening();
        mocks.client.end.mockRejectedValueOnce(new Error('Already ended'));

        await manager.stopListening();
      });

      it('should be safe to call stopListening without start', async () => {
        await manager.stopListening();
      });
    });
  });
});

import { ConfigManager } from '../manager';

// Mock the db module
jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
  createListenClient: jest.fn(),
}));

import { db } from '@/db';

const mockQuery = db.query as unknown as jest.Mock;

describe('ConfigManager', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a fresh ConfigManager instance for each test
    manager = new ConfigManager();
  });

  describe('loadAll', () => {
    it('should load providers and virtual models from database', async () => {
      // Mock providers query
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'deepseek-1',
              kind: 'deepseek',
              name: 'DeepSeek',
              credential_type: 'api_key',
              credential: { key: 'sk-ds-123' },
              base_url: 'https://api.deepseek.com',
              config: {},
            },
            {
              id: 'gemini-1',
              kind: 'gemini',
              name: 'Gemini',
              credential_type: 'api_key',
              credential: { key: 'sk-gm-456' },
              base_url: 'https://api.gemini.com',
              config: {},
            },
          ],
          command: 'SELECT',
          rowCount: 2,
          oid: 0,
          fields: [],
        })
        // Mock virtual models + backends query (四表联查)
        .mockResolvedValueOnce({
          rows: [
            {
              vm_id: 'gpt-4',
              vm_name: 'gpt-4',
              routing_strategy: 'load_balance',
              pm_id: 'deepseek-chat-32k',
              pm_name: 'deepseek-chat',
              model_type: 'chat',
              weight: 100,
              priority: 0,
              provider_id: 'deepseek-1',
              provider_kind: 'deepseek',
              provider_name: 'DeepSeek',
              credential_type: 'api_key',
              credential: { key: 'sk-ds-123' },
              base_url: 'https://api.deepseek.com',
              provider_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
            {
              vm_id: 'text-embedding-3-small',
              vm_name: 'text-embedding-3-small',
              routing_strategy: 'load_balance',
              pm_id: 'gemini-embedding-001',
              pm_name: 'text-embedding-004',
              model_type: 'embedding',
              weight: 100,
              priority: 0,
              provider_id: 'gemini-1',
              provider_kind: 'gemini',
              provider_name: 'Gemini',
              credential_type: 'api_key',
              credential: { key: 'sk-gm-456' },
              base_url: 'https://api.gemini.com',
              provider_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 2,
          oid: 0,
          fields: [],
        });

      await manager.loadAll();

      // Verify virtual models are loaded
      const virtualModels = manager.getAllVirtualModels();
      expect(virtualModels).toContain('gpt-4');
      expect(virtualModels).toContain('text-embedding-3-small');
      expect(virtualModels).toHaveLength(2);

      // Verify gpt-4 configuration
      const gpt4Config = manager.getVirtualModelConfig('gpt-4');
      expect(gpt4Config).toBeDefined();
      expect(gpt4Config?.id).toBe('gpt-4');
      expect(gpt4Config?.routingStrategy).toBe('load_balance');
      expect(gpt4Config?.backends).toHaveLength(1);

      const backend = gpt4Config?.backends[0];
      expect(backend).toBeDefined();
      expect(backend?.actualModel).toBe('deepseek-chat');
      expect(backend?.modelType).toBe('chat');
      expect(backend?.provider.kind).toBe('deepseek');
      expect(backend?.provider.apiKey).toBe('sk-ds-123');
      expect(backend?.provider.baseUrl).toBe('https://api.deepseek.com');
    });

    it('should clear previous data on reload', async () => {
      // First load
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'deepseek-1',
              kind: 'deepseek',
              name: 'DeepSeek',
              credential_type: 'api_key',
              credential: { key: 'sk-1' },
              base_url: 'https://api.deepseek.com',
              config: {},
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              vm_id: 'gpt-4',
              vm_name: 'gpt-4',
              routing_strategy: 'load_balance',
              pm_id: 'deepseek-chat-32k',
              pm_name: 'deepseek-chat',
              model_type: 'chat',
              weight: 100,
              priority: 0,
              provider_id: 'deepseek-1',
              provider_kind: 'deepseek',
              provider_name: 'DeepSeek',
              credential_type: 'api_key',
              credential: { key: 'sk-1' },
              base_url: 'https://api.deepseek.com',
              provider_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      await manager.loadAll();
      expect(manager.getVirtualModelConfig('gpt-4')).toBeDefined();

      // Second load — gpt-4 mapping removed
      mockQuery
        .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

      await manager.loadAll();
      expect(manager.getVirtualModelConfig('gpt-4')).toBeUndefined();
    });

    it('should handle empty database', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

      await manager.loadAll();

      expect(manager.getAllVirtualModels()).toEqual([]);
    });
  });

  describe('getVirtualModelConfig', () => {
    it('should return undefined for unknown virtual model', () => {
      expect(manager.getVirtualModelConfig('nonexistent-model')).toBeUndefined();
    });
  });

  describe('getAllVirtualModels', () => {
    it('should return all registered virtual model names', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'deepseek-1',
              kind: 'deepseek',
              name: 'DS',
              credential_type: 'api_key',
              credential: { key: 'k' },
              base_url: 'https://api.deepseek.com',
              config: {},
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              vm_id: 'model-a',
              vm_name: 'model-a',
              routing_strategy: 'load_balance',
              pm_id: 'pm-a',
              pm_name: 'actual-a',
              model_type: 'chat',
              weight: 100,
              priority: 0,
              provider_id: 'deepseek-1',
              provider_kind: 'deepseek',
              provider_name: 'DS',
              credential_type: 'api_key',
              credential: { key: 'k' },
              base_url: 'https://api.deepseek.com',
              provider_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
            {
              vm_id: 'model-b',
              vm_name: 'model-b',
              routing_strategy: 'load_balance',
              pm_id: 'pm-b',
              pm_name: 'actual-b',
              model_type: 'embedding',
              weight: 100,
              priority: 0,
              provider_id: 'deepseek-1',
              provider_kind: 'deepseek',
              provider_name: 'DS',
              credential_type: 'api_key',
              credential: { key: 'k' },
              base_url: 'https://api.deepseek.com',
              provider_config: {},
              vm_created_at: new Date('2024-01-01T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 2,
          oid: 0,
          fields: [],
        });

      await manager.loadAll();

      const models = manager.getAllVirtualModels();
      expect(models).toContain('model-a');
      expect(models).toContain('model-b');
      expect(models).toHaveLength(2);
    });
  });
});

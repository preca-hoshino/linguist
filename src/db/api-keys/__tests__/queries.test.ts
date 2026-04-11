import { db } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { invalidateApiKeyCache, lookupKey } from '../cache';
import {
  createApiKey,
  deleteApiKey,
  getApiKeyById,
  listApiKeys,
  rotateApiKey,
  updateApiKey,
  validateApiKey,
} from '../queries';

jest.mock('@/db/client', () => ({
  db: {
    query: jest.fn(),
  },
}));

jest.mock('@/db/id-generator', () => ({
  generateShortId: jest.fn(),
}));

jest.mock('../cache', () => ({
  invalidateApiKeyCache: jest.fn(),
  lookupKey: jest.fn(),
}));

describe('API Keys Queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createApiKey', () => {
    it('should create an API key under an app and return it', async () => {
      (generateShortId as jest.Mock).mockResolvedValue('ak_123');
      const mockResult = {
        rows: [
          {
            id: 'ak_123',
            app_id: 'app_1',
            name: 'Test Key',
            key_value: 'lk-abc',
            key_prefix: 'lk-abcdef',
            expires_at: null,
          },
        ],
      };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      const result = await createApiKey('app_1', 'Test Key');

      expect(generateShortId).toHaveBeenCalledWith('api_keys');
      expect(db.query).toHaveBeenCalledWith(expect.any(String), [
        'ak_123',
        'app_1',
        'Test Key',
        expect.any(String), // key_value
        expect.any(String), // prefix
        null,
      ]);
      expect(invalidateApiKeyCache).toHaveBeenCalled();
      expect(result.id).toBe('ak_123');
      expect(result.app_id).toBe('app_1');
    });

    it('should throw if no row is returned', async () => {
      (generateShortId as jest.Mock).mockResolvedValue('ak_123');
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      await expect(createApiKey('app_1', 'Test Key')).rejects.toThrow('Failed to create API key: no row returned');
    });
  });

  describe('listApiKeys', () => {
    it('should list API keys with pagination', async () => {
      const mockResult = {
        rows: [
          { id: '1', name: 'Key 1', total: '2' },
          { id: '2', name: 'Key 2', total: '2' },
        ],
      };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      const result = await listApiKeys({ limit: 10 });

      expect(db.query).toHaveBeenCalled();
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect((result.data[0] as Record<string, unknown>).full_count).toBeUndefined(); // ensure full_count is stripped
    });

    it('should handle search queries', async () => {
      const mockResult = { rows: [] };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      await listApiKeys({ search: 'test' });

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE (name ILIKE $1 OR key_prefix ILIKE $1)'), [
        '%test%',
        11,
      ]);
    });

    it('should filter by appId', async () => {
      const mockResult = { rows: [] };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      await listApiKeys({ appId: 'app_1' });

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE app_id = $1'), ['app_1', 11]);
    });

    it('should return empty list when no keys exist', async () => {
      const mockResult = { rows: [] };
      (db.query as jest.Mock).mockResolvedValue(mockResult);

      const result = await listApiKeys();

      expect(result.total).toBe(0);
      expect(result.data).toEqual([]);
    });
  });

  describe('getApiKeyById', () => {
    it('should return key summary by ID', async () => {
      const keyData = { id: 'ak_1', name: 'Key 1' };
      (db.query as jest.Mock).mockResolvedValue({ rows: [keyData] });

      const result = await getApiKeyById('ak_1');

      expect(db.query).toHaveBeenCalledWith(expect.any(String), ['ak_1']);
      expect(result).toEqual(keyData);
    });

    it('should return null if not found', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      const result = await getApiKeyById('ak_unknown');

      expect(result).toBeNull();
    });
  });

  describe('updateApiKey', () => {
    it('should update and return key summary', async () => {
      const keyData = { id: 'ak_1', name: 'Updated Key', is_active: false };
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1, rows: [keyData] });

      const result = await updateApiKey('ak_1', { name: 'Updated Key', is_active: false });

      expect(db.query).toHaveBeenCalledWith(expect.any(String), ['Updated Key', false, 'ak_1']);
      expect(invalidateApiKeyCache).toHaveBeenCalled();
      expect(result).toEqual(keyData);
    });

    it('should return null if no fields to update', async () => {
      const result = await updateApiKey('ak_1', {});

      expect(db.query).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('should return null if key not found', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 0, rows: [] });

      const result = await updateApiKey('ak_1', { name: 'Updated Key' });

      expect(result).toBeNull();
    });
  });

  describe('rotateApiKey', () => {
    it('should rotate key and return new key_value', async () => {
      const keyData = { id: 'ak_1', name: 'Key 1', key_value: 'lk-new' };
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1, rows: [keyData] });

      const result = await rotateApiKey('ak_1');

      expect(db.query).toHaveBeenCalledWith(expect.any(String), [
        'ak_1',
        expect.any(String), // new key_value
        expect.any(String), // new prefix
      ]);
      expect(invalidateApiKeyCache).toHaveBeenCalled();
      expect(result?.id).toBe('ak_1');
    });

    it('should return null if key not found', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 0, rows: [] });

      const result = await rotateApiKey('ak_1');

      expect(result).toBeNull();
    });
  });

  describe('deleteApiKey', () => {
    it('should delete key and return true', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1 });

      const result = await deleteApiKey('ak_1');

      expect(db.query).toHaveBeenCalledWith(expect.any(String), ['ak_1']);
      expect(invalidateApiKeyCache).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false if key not found', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 0 });

      const result = await deleteApiKey('ak_1');

      expect(result).toBe(false);
    });
  });

  describe('validateApiKey', () => {
    it('should return user info with appId if valid', async () => {
      const date = new Date();
      date.setFullYear(date.getFullYear() + 1); // Future
      (lookupKey as jest.Mock).mockResolvedValue({ id: 'ak_1', name: 'Valid Key', appId: 'app_1', expiresAt: date });

      const result = await validateApiKey('lk-some-valid-key');

      expect(lookupKey).toHaveBeenCalledWith('lk-some-valid-key');
      expect(result).toEqual({ id: 'ak_1', name: 'Valid Key', appId: 'app_1' });
    });

    it('should return null if not cached/found', async () => {
      (lookupKey as jest.Mock).mockResolvedValue(undefined);

      const result = await validateApiKey('lk-invalid-key');

      expect(result).toBeNull();
    });

    it('should return null if expired', async () => {
      const date = new Date('2020-01-01T00:00:00Z'); // Past
      (lookupKey as jest.Mock).mockResolvedValue({ id: 'ak_1', name: 'Expired Key', appId: 'app_1', expiresAt: date });

      const result = await validateApiKey('lk-expired-key');

      expect(result).toBeNull();
    });

    it('should return user info if valid and no expiration', async () => {
      (lookupKey as jest.Mock).mockResolvedValue({
        id: 'ak_1',
        name: 'No Expire Key',
        appId: 'app_1',
        expiresAt: null,
      });

      const result = await validateApiKey('lk-no-expire-key');

      expect(result).toEqual({ id: 'ak_1', name: 'No Expire Key', appId: 'app_1' });
    });
  });
});

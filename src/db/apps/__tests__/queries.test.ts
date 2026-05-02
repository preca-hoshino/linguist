/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-call */
import { db, withTransaction } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { createApp, listApps, updateApp, deleteApp, rotateAppKey } from '../queries';
import { invalidateAppCache } from '../cache';

// Mock dependencies
jest.mock('@/db/client', () => ({
  db: {
    query: jest.fn(),
  },
  withTransaction: jest.fn(),
}));

jest.mock('@/db/id-generator', () => ({
  generateShortId: jest.fn(),
}));

jest.mock('../cache', () => ({
  invalidateAppCache: jest.fn(),
}));

jest.mock('@/utils', () => {
  const original = jest.requireActual('@/utils');
  return {
    ...original,
    createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
  };
});

describe('App Queries', () => {
  const mockDbQuery = db.query as jest.Mock;
  const mockWithTransaction = withTransaction as jest.Mock;
  const mockGenerateShortId = generateShortId as jest.Mock;
  const mockInvalidateAppCache = invalidateAppCache as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockWithTransaction.mockImplementation((cb) => {
      const tx = { query: jest.fn() };
      return cb(tx);
    });
  });

  describe('createApp', () => {
    it('should generate short id and insert app and its capabilities', async () => {
      mockGenerateShortId.mockResolvedValue('app_xyz123');
      const txQuery = jest.fn();
      mockWithTransaction.mockImplementation((cb) => cb({ query: txQuery }));

      const mockRow = { id: 'app_xyz123', name: 'Test App' };
      // The last query call in createApp returns the grouped row
      txQuery.mockResolvedValueOnce({ rowCount: 1 }); // apps
      txQuery.mockResolvedValueOnce({ rowCount: 2 }); // models
      txQuery.mockResolvedValueOnce({ rowCount: 1 }); // mcps
      txQuery.mockResolvedValueOnce({ rows: [mockRow] }); // SELECT response

      const result = await createApp({
        name: 'Test App',
        allowed_model_ids: ['vm_1', 'vm_2'],
        allowed_mcp_ids: ['mcp_1'],
      });

      expect(mockGenerateShortId).toHaveBeenCalledWith('apps');
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO apps'), [
        'app_xyz123',
        'Test App',
        '{}',
      ]);
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_allowed_models'), [
        'app_xyz123',
        'vm_1',
        'app_xyz123',
        'vm_2',
      ]);
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_allowed_mcps'), [
        'app_xyz123',
        'mcp_1',
      ]);
      expect(mockInvalidateAppCache).toHaveBeenCalled();
      expect(result).toEqual(mockRow);
    });
  });

  describe('listApps', () => {
    it('should build sql condition for search and offset', async () => {
      const countResult = { rows: [{ total: '5' }] };
      const listResult = { rows: [{ id: 'app_2' }, { id: 'app_3' }] };

      // First call is COUNT, second call is SELECT
      mockDbQuery.mockResolvedValueOnce(countResult).mockResolvedValueOnce(listResult);

      const result = await listApps({
        limit: 10,
        offset: 10,
        search: 'Demo',
        is_active: true,
      });

      // COUNT query
      expect(mockDbQuery).toHaveBeenNthCalledWith(1, expect.stringContaining('COUNT(*)'), ['%Demo%', true]);

      // SELECT query -> search criteria (%Demo%), active check (true), limit (10), offset (10)
      expect(mockDbQuery).toHaveBeenNthCalledWith(2, expect.stringContaining('LIMIT $3 OFFSET $4'), [
        '%Demo%',
        true,
        10,
        10,
      ]);

      expect(result.data).toHaveLength(2);
      expect(result.has_more).toBe(false);
      expect(result.total).toBe(5);
    });
  });

  describe('updateApp', () => {
    it('should incrementally update provided fields using buildUpdateSet', async () => {
      const txQuery = jest.fn();
      mockWithTransaction.mockImplementation((cb) => cb({ query: txQuery }));

      txQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE apps
      txQuery.mockResolvedValueOnce({ rows: [{ id: 'app_xyz123', name: 'Updated' }] }); // SELECT ...

      const result = await updateApp('app_xyz123', { name: 'Updated' });

      // Check that only name is updated and parameter array looks like ['Updated', 'app_xyz123']
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE apps SET name = $1'), [
        'Updated',
        'app_xyz123',
      ]);

      expect(mockInvalidateAppCache).toHaveBeenCalled();
      expect(result).toEqual({ id: 'app_xyz123', name: 'Updated' });
    });

    it('should update capability relations when provided', async () => {
      const txQuery = jest.fn();
      mockWithTransaction.mockImplementation((cb) => cb({ query: txQuery }));

      txQuery.mockResolvedValueOnce({ rowCount: 1 }); // DELETE app_allowed_models ...
      txQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT app_allowed_models ...
      txQuery.mockResolvedValueOnce({ rows: [{ id: 'app_xyz123' }] }); // SELECT ...

      await updateApp('app_xyz123', { allowed_model_ids: ['vm_999'] });

      // No apps update because no app fields provided
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM app_allowed_models'), ['app_xyz123']);
      expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_allowed_models'), [
        'app_xyz123',
        'vm_999',
      ]);
    });
  });

  describe('deleteApp', () => {
    it('should successfully delete app and invalidate cache', async () => {
      mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });
      const result = await deleteApp('app_xyz123');
      expect(result).toBe(true);
      expect(mockInvalidateAppCache).toHaveBeenCalled();
    });

    it('should return false if nothing to delete', async () => {
      mockDbQuery.mockResolvedValueOnce({ rowCount: 0 });
      const result = await deleteApp('app_xyz123');
      expect(result).toBe(false);
      expect(mockInvalidateAppCache).not.toHaveBeenCalled();
    });
  });

  describe('rotateAppKey', () => {
    it('should update key with random hex and invalidate cache', async () => {
      const mockApp = { id: 'app_xyz', api_key: 'lk-abcd' };
      mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [mockApp] });
      const result = await rotateAppKey('app_xyz');
      expect(result).toEqual(mockApp);
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET api_key = 'lk-' || encode(gen_random_bytes(24), 'hex')"),
        ['app_xyz'],
      );
      expect(mockInvalidateAppCache).toHaveBeenCalled();
    });
  });
});

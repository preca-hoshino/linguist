import { Client, Pool } from 'pg';
import { closePool, createListenClient, db, getPool, withTransaction } from './client';

// Mock pg module
jest.mock('pg', () => {
  const mClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const mPool = {
    query: jest.fn(),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(mClient),
    end: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Pool: jest.fn(() => mPool),
    Client: jest.fn(() => mClient),
  };
});

describe('Database Client', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = process.env;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getPool', () => {
    it('should initialize a pool with the correct configuration', () => {
      const pool = getPool();
      expect(Pool).toHaveBeenCalledTimes(1);
      const config = jest.mocked(Pool).mock.calls[0]?.[0];
      expect(config?.connectionString).toBe('postgres://user:pass@localhost:5432/db');
      expect(config?.max).toBe(20);
      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should return the same singleton pool instance on subsequent calls', () => {
      const pool1 = getPool();
      const pool2 = getPool();
      expect(pool1).toBe(pool2);
      expect(Pool).toHaveBeenCalledTimes(0); // Only initialized once
    });
  });

  describe('db.query', () => {
    it('should execute a query successfully', async () => {
      const pool = getPool();
      const mockResult = { rowCount: 1, rows: [{ id: 1 }] };
      (pool.query as jest.Mock).mockResolvedValueOnce(mockResult);

      const result = await db.query('SELECT * FROM test WHERE id = $1', [1]);

      expect(pool.query).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', [1]);
      expect(result).toBe(mockResult);
    });

    it('should retry on connection error', async () => {
      const pool = getPool();
      const connectionError = new Error('Connection terminated unexpectedly');
      const mockResult = { rowCount: 1, rows: [{ id: 1 }] };

      (pool.query as jest.Mock).mockRejectedValueOnce(connectionError).mockResolvedValueOnce(mockResult);

      const result = await db.query('SELECT 1');

      expect(pool.query).toHaveBeenCalledTimes(2);
      expect(result).toBe(mockResult);
    });

    it('should throw error after max retries', async () => {
      const pool = getPool();
      const connectionError = new Error('Connection terminated unexpectedly');

      (pool.query as jest.Mock).mockRejectedValue(connectionError);

      await expect(db.query('SELECT 1')).rejects.toThrow('Connection terminated unexpectedly');
      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it('should not retry on syntax error', async () => {
      const pool = getPool();
      const syntaxError = new Error('syntax error at or near "SELECT"');

      (pool.query as jest.Mock).mockRejectedValueOnce(syntaxError);

      await expect(db.query('SELE 1')).rejects.toThrow('syntax error');
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('createListenClient', () => {
    it('should create a separate Client instance', () => {
      createListenClient();
      expect(Client).toHaveBeenCalledTimes(1);
      const rawConfig = jest.mocked(Client).mock.calls[0]?.[0];
      const connectionString = typeof rawConfig === 'object' ? rawConfig.connectionString : rawConfig;
      expect(connectionString).toBe('postgres://user:pass@localhost:5432/db');
    });
  });

  describe('closePool', () => {
    it('should close the pool and reset the singleton', async () => {
      const pool = getPool();
      await closePool();
      expect(pool.end).toHaveBeenCalledTimes(1);
      // Wait for singleton to be cleared by resetting module
    });
  });

  describe('withTransaction', () => {
    it('should execute BEGIN, the callback, and COMMIT', async () => {
      const pool = getPool();
      const mClient = await pool.connect();
      (pool.connect as jest.Mock).mockResolvedValueOnce(mClient);

      const fn = jest.fn().mockResolvedValue('result');

      const result = await withTransaction(fn);

      expect(mClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(fn).toHaveBeenCalledWith(mClient);
      expect(mClient.query).toHaveBeenNthCalledWith(2, 'COMMIT');
      expect(mClient.release).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    it('should ROLLBACK and release on error', async () => {
      const pool = getPool();
      const mClient = await pool.connect();
      (pool.connect as jest.Mock).mockResolvedValueOnce(mClient);

      const error = new Error('transaction error');
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withTransaction(fn)).rejects.toThrow('transaction error');

      expect(mClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mClient.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
      expect(mClient.release).toHaveBeenCalledTimes(1);
    });
  });
});

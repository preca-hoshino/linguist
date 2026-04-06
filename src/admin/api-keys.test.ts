import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import * as dbApiKeys from '@/db/api-keys';
import { apiKeysRouter } from './api-keys';

jest.mock('@/db/api-keys', () => ({
  createApiKey: jest.fn(),
  listApiKeys: jest.fn(),
  getApiKeyById: jest.fn(),
  updateApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
  deleteApiKey: jest.fn(),
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

const app = express();
app.use(express.json());
// Global error handler to catch errors passed to next()
app.use('/api-keys', apiKeysRouter);
app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 500).json({
    error: {
      code: err.code ?? 'internal_error',
      message: err.message,
    },
  });
});

describe('API Keys Router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api-keys', () => {
    it('should list api keys with default pagination', async () => {
      (dbApiKeys.listApiKeys as jest.Mock).mockResolvedValue({
        data: [{ id: 'key1' }],
        total: 1,
      });

      const res = await request(app).get('/api-keys');
      expect(res.status).toBe(200);
      expect(dbApiKeys.listApiKeys).toHaveBeenCalledWith({ limit: 10, offset: 0 });
      expect(res.body).toEqual({
        object: 'list',
        data: [{ object: 'api_key', id: 'key1' }],
        total: 1,
        has_more: false,
      });
    });

    it('should list api keys with custom pagination', async () => {
      (dbApiKeys.listApiKeys as jest.Mock).mockResolvedValue({
        data: [{ id: 'key1' }],
        total: 10,
      });

      const res = await request(app).get('/api-keys?limit=5&offset=2&search=test');
      expect(res.status).toBe(200);
      expect(dbApiKeys.listApiKeys).toHaveBeenCalledWith({ limit: 5, offset: 2, search: 'test' });
      expect((res.body as { has_more: boolean }).has_more).toBe(true);
    });
  });

  describe('GET /api-keys/:id', () => {
    it('should get an api key by id', async () => {
      (dbApiKeys.getApiKeyById as jest.Mock).mockResolvedValue({ id: 'key1' });

      const res = await request(app).get('/api-keys/key1');
      expect(res.status).toBe(200);
      expect(dbApiKeys.getApiKeyById).toHaveBeenCalledWith('key1');
      expect((res.body as { object: string }).object).toEqual('api_key');
    });

    it('should return 404 if key is not found', async () => {
      (dbApiKeys.getApiKeyById as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api-keys/not-found');
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
    });
  });

  describe('POST /api-keys', () => {
    it('should create an api key successfully', async () => {
      (dbApiKeys.createApiKey as jest.Mock).mockResolvedValue({ id: 'new-key' });

      const res = await request(app).post('/api-keys').send({ name: 'Test Key' });
      expect(res.status).toBe(201);
      expect(dbApiKeys.createApiKey).toHaveBeenCalledWith('Test Key', undefined);
      expect(res.body).toEqual(expect.objectContaining({ object: 'api_key', id: 'new-key' }));
    });

    it('should return 400 if name is invalid', async () => {
      const res = await request(app).post('/api-keys').send({ name: '' });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it('should return 400 if expires_at is invalid', async () => {
      const res = await request(app).post('/api-keys').send({ name: 'Test', expires_at: 'invalid-date' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api-keys/:id', () => {
    it('should update an api key', async () => {
      (dbApiKeys.updateApiKey as jest.Mock).mockResolvedValue({ id: 'key1', name: 'Updated' });

      const res = await request(app).patch('/api-keys/key1').send({ name: 'Updated' });
      expect(res.status).toBe(200);
      expect(dbApiKeys.updateApiKey).toHaveBeenCalledWith('key1', {
        name: 'Updated',
        is_active: undefined,
        expires_at: undefined,
      });
    });

    it('should return 400 if no fields to update', async () => {
      const res = await request(app).patch('/api-keys/key1').send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 if updating non-existent key', async () => {
      (dbApiKeys.updateApiKey as jest.Mock).mockResolvedValue(null);
      const res = await request(app).patch('/api-keys/key1').send({ name: 'Updated' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api-keys/:id/rotate', () => {
    it('should rotate an api key', async () => {
      (dbApiKeys.rotateApiKey as jest.Mock).mockResolvedValue({ id: 'key1', key: 'new-secret' });

      const res = await request(app).post('/api-keys/key1/rotate');
      expect(res.status).toBe(200);
      expect(dbApiKeys.rotateApiKey).toHaveBeenCalledWith('key1');
    });

    it('should return 404 if rotating non-existent key', async () => {
      (dbApiKeys.rotateApiKey as jest.Mock).mockResolvedValue(null);
      const res = await request(app).post('/api-keys/key1/rotate');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api-keys/:id', () => {
    it('should delete an api key', async () => {
      (dbApiKeys.deleteApiKey as jest.Mock).mockResolvedValue(true);

      const res = await request(app).delete('/api-keys/key1');
      expect(res.status).toBe(200);
      expect(dbApiKeys.deleteApiKey).toHaveBeenCalledWith('key1');
      expect(res.body).toEqual({ id: 'key1', object: 'api_key', deleted: true });
    });

    it('should return 404 if deleting non-existent key', async () => {
      (dbApiKeys.deleteApiKey as jest.Mock).mockResolvedValue(false);
      const res = await request(app).delete('/api-keys/key1');
      expect(res.status).toBe(404);
    });
  });
});

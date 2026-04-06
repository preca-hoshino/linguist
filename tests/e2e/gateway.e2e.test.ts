import request from 'supertest';
import { app } from '@/server';
import { db } from '@/db';
import { configManager } from '@/config';

// 模拟数据库
jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
  createListenClient: jest.fn(),
}));

describe('Gateway E2E Tests', () => {
  const mockQuery = db.query as jest.MockedFunction<typeof db.query>;

  beforeAll(async () => {
    // 初始化 configManager 使得路由可以找到模型
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'test-1',
            kind: 'mock-p',
            name: 'Mock',
            credential_type: 'api_key',
            credential: { key: 'sk-123' },
            base_url: 'https://test.local',
            config: {},
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            vm_id: 'gpt-4',
            vm_name: 'gpt-4',
            routing_strategy: 'load_balance',
            pm_id: 'mock-chat-1',
            pm_name: 'mock-chat',
            model_type: 'chat',
            weight: 100,
            priority: 0,
            provider_id: 'test-1',
            provider_kind: 'mock-p', // 假设我们在测试中并不真实依赖具体 Plugin 或只是利用默认兜底
            provider_name: 'Mock',
            credential_type: 'api_key',
            credential: { key: 'sk-123' },
            base_url: 'https://test.local',
            provider_config: {},
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      } as any);

    await configManager.loadAll();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/health', () => {
    it('should return 200 OK with health status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });
  });

  describe('Gateway Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/v1/unknown-route');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: {
          code: 'not_found',
          message: 'Not Found',
        },
      });
    });

    it('should process Gemini format error if in Gemini path', async () => {
      const response = await request(app).get('/v1beta/models');
      
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 404); // Gemini style
      expect(response.body.error).toHaveProperty('status', 'NOT_FOUND');
    });
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthorized requests to /v1/chat/completions', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      // 未携带 Token 的情况下应该拒绝
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    });

    it('should reject invalid auth tokens format', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'InvalidFormat')
        .send({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    });
  });

  describe('Validation', () => {
    it('should validate request schema and return 400 on failure', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          // missing 'model' field
          messages: [{ role: 'user', content: 'test' }],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'missing_model');
    });
  });
});

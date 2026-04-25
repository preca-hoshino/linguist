/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import request from 'supertest';
import { app } from '@/server';
import { db, withTransaction } from '@/db';
import { rateLimiter } from '@/utils';

// Mock DB and Transaction
jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
  withTransaction: jest.fn(),
  createListenClient: jest.fn(),
  generateShortId: jest.fn().mockResolvedValue('vm-test-id'),
  markProcessing: jest.fn(),
  markSuccess: jest.fn(),
  markError: jest.fn(),
}));

// Global auth mock bypass for admin routes
jest.mock('@/admin/auth', () => ({
  adminAuth: (req: any, _res: any, next: any) => {
    req.admin = { id: 'admin-1', role: 'admin' };
    next();
  },
}));

describe('Admin Internal API: Virtual Models', () => {
  const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
  const mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default simple mock for withTransaction
    mockWithTransaction.mockImplementation(async (callback) => {
      const tx = { query: jest.fn() };
      return await callback(tx as any);
    });

    jest.spyOn(rateLimiter, 'getRpmUsage').mockReturnValue(10);
    jest.spyOn(rateLimiter, 'getTpmUsage').mockReturnValue(100);
  });

  describe('GET /api/model/virtual-models', () => {
    it('should return paginated virtual models with backends array', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: '1' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // count result

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'vm-1',
            name: 'test-vm',
            description: 'test desc',
            model_type: 'chat',
            routing_strategy: 'load_balance',
            is_active: true,
            rpm_limit: null,
            tpm_limit: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // data result

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            virtual_model_id: 'vm-1',
            provider_model_id: 'pm-1',
            weight: 10,
            priority: 0,
            provider_model_name: 'gpt-4',
            provider_name: 'OpenAI',
            provider_id: 'p-1',
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // backend result for expand

      const response = await request(app).get('/api/model/virtual-models?expand=backends');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toHaveProperty('id', 'vm-1');
      expect(response.body.data[0].backends).toHaveLength(1);
      expect(response.body.data[0].backends[0]).toHaveProperty('provider_model_id', 'pm-1');
      expect(response.body.data[0].throughput).toHaveProperty('rpm', 10);
    });
  });

  describe('GET /api/model/virtual-models/:id', () => {
    it('should return a single virtual model and its backends', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'vm-1',
            name: 'test-vm',
            model_type: 'chat',
            routing_strategy: 'failover',
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // vm info

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            provider_model_id: 'pm-1',
            weight: 10,
            priority: 0,
          },
        ],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // backends info without expand

      const response = await request(app).get('/api/model/virtual-models/vm-1');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', 'vm-1');
      expect(response.body.backends).toHaveLength(1);
      expect(response.body.backends[0]).toHaveProperty('weight', 10);
    });

    it('should return 404 if not found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      }); // empty

      const response = await request(app).get('/api/model/virtual-models/vm-not-exist');
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/model/virtual-models', () => {
    const validPayload = {
      name: 'new-vm',
      description: 'my new vm',
      model_type: 'chat',
      routing_strategy: 'load_balance',
      backends: [{ provider_model_id: 'pm-1', weight: 1 }],
    };

    it('should validate missing required fields', async () => {
      const response = await request(app).post('/api/model/virtual-models').send({});
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('name is required');
    });

    it('should fail if backends are not provided', async () => {
      const payload = { ...validPayload, backends: [] };
      const response = await request(app).post('/api/model/virtual-models').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('At least one backend is required');
    });

    it('should fail if provider model does not exist or type mismatches', async () => {
      // Mock provider models check query returning empty
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

      const response = await request(app).post('/api/model/virtual-models').send(validPayload);
      expect(response.status).toBe(404);
      expect(response.body.error.message).toContain('Provider model(s) not found');
    });

    it('should successfully create a virtual model and its backends', async () => {
      // 1. pmCheck queries
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pm-1', model_type: 'chat' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // 2. loadVirtualModelWithBackends
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'vm-test-id', name: 'new-vm', model_type: 'chat', routing_strategy: 'load_balance' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // vm
      mockQuery.mockResolvedValueOnce({
        rows: [{ provider_model_id: 'pm-1', weight: 1, priority: 0 }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      }); // backends

      const response = await request(app).post('/api/model/virtual-models').send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id', 'vm-test-id');
      expect(mockWithTransaction).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/model/virtual-models/:id', () => {
    const updatePayload = {
      model_type: 'chat',
      backends: [{ provider_model_id: 'pm-new', weight: 100 }],
    };

    it('should return 404 if virtual model does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] });

      const response = await request(app).patch('/api/model/virtual-models/vm-not-found').send(updatePayload);
      expect(response.status).toBe(404);
    });

    it('should fail if new backends have mismatched model_type', async () => {
      // 1. existCheck
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'vm-1', model_type: 'chat' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });
      // 2. backend pmCheck returning mistyped backend
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pm-new', model_type: 'embedding' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await request(app).patch('/api/model/virtual-models/vm-1').send(updatePayload);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('different type');
    });

    it('should successfully update virtual model and replace backends', async () => {
      // 1. existCheck
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'vm-1', model_type: 'chat' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });
      // 2. backend pmCheck
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pm-new', model_type: 'chat' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });
      // 3. reload vm (after update)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'vm-1', model_type: 'chat' }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ provider_model_id: 'pm-new', weight: 100, priority: 0 }],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await request(app)
        .patch('/api/model/virtual-models/vm-1')
        .send({
          name: 'updated-name',
          backends: [{ provider_model_id: 'pm-new', weight: 100 }],
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', 'vm-1');
      expect(mockWithTransaction).toHaveBeenCalled(); // verified tx replacement
    });
  });

  describe('DELETE /api/model/virtual-models/:id', () => {
    it('should return 404 if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'DELETE', rowCount: 0, oid: 0, fields: [] });
      const response = await request(app).delete('/api/model/virtual-models/vm-not');
      expect(response.status).toBe(404);
    });

    it('should successfully delete a virtual model', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }], command: 'DELETE', rowCount: 1, oid: 0, fields: [] });
      const response = await request(app).delete('/api/model/virtual-models/vm-1');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deleted', true);
    });
  });
});

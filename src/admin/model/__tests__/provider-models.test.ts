/* eslint-disable */
import express from 'express';
import request from 'supertest';
import { db, generateShortId } from '@/db';
import { providerModelsRouter } from '../provider-models';

jest.mock('@/db', () => ({
  db: { query: jest.fn() },
  generateShortId: jest.fn(),
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
  rateLimiter: {
    getRpmUsage: jest.fn().mockReturnValue(0),
    getTpmUsage: jest.fn().mockReturnValue(0),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/model/provider-models', providerModelsRouter);

describe('Provider Models API Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validPayload = {
    provider_id: 'provider-123',
    name: 'Test Chat Model',
    model_type: 'chat',
    capabilities: ['stream', 'cache', 'vision', 'tools', 'thinking', 'structured_output'],
    supported_parameters: ['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'stop'],
    max_tokens: 8192,
  };

  it('should successfully create a new provider model', async () => {
    // 1. Mock DB check for provider existence (returns kind for cross-validation)
    (db.query as jest.Mock).mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'provider-123', kind: 'deepseek' }],
    });
    // 2. Mock DB insertion
    (generateShortId as jest.Mock).mockResolvedValue('short-id-123');
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: 'short-id-123',
          ...validPayload,
          model_config: '{}',
          pricing_tiers: '[]',
          rpm_limit: null,
          tpm_limit: null,
          is_active: true,
        },
      ],
    });

    const res = await request(app).post('/api/model/provider-models').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.object).toBe('provider_model');
    expect(res.body.supported_parameters).toEqual([
      'temperature',
      'top_p',
      'max_tokens',
      'frequency_penalty',
      'presence_penalty',
      'stop',
    ]);
    expect(res.body.capabilities).toEqual(['stream', 'cache', 'vision', 'tools', 'thinking', 'structured_output']);
  });

  it('should successfully create an embedding model with specific capabilities and parameters', async () => {
    (db.query as jest.Mock).mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'provider-123', kind: 'gemini' }],
    });
    (generateShortId as jest.Mock).mockResolvedValue('short-id-embed');
    (db.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: 'short-id-embed',
          provider_id: 'provider-123',
          name: 'Embed Model',
          model_type: 'embedding',
          capabilities: ['multimodal', 'dynamic_dim'],
          supported_parameters: ['dimensions', 'encoding_format'],
          model_config: '{}',
          pricing_tiers: '[]',
          max_tokens: 1024,
          rpm_limit: null,
          tpm_limit: null,
          is_active: true,
        },
      ],
    });

    const res = await request(app)
      .post('/api/model/provider-models')
      .send({
        provider_id: 'provider-123',
        name: 'Embed Model',
        model_type: 'embedding',
        capabilities: ['multimodal', 'dynamic_dim'],
        supported_parameters: ['dimensions', 'encoding_format'],
        max_tokens: 1024,
      });

    expect(res.status).toBe(201);
    expect(res.body.capabilities).toEqual(['multimodal', 'dynamic_dim']);
    expect(res.body.supported_parameters).toEqual(['dimensions', 'encoding_format']);
  });

  it('should fail with 400 when an invalid supported_parameter is provided', async () => {
    const invalidPayload = {
      ...validPayload,
      supported_parameters: ['temperature', 'invalid_fake_param'],
    };

    const res = await request(app).post('/api/model/provider-models').send(invalidPayload);

    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('invalid_request');
    expect((res.body as any).error.message).toContain('Invalid chat supported parameters: invalid_fake_param');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should fail with 400 when supported_parameter conflicts with provider capabilities', async () => {
    // Gemini does not support presence_penalty or frequency_penalty
    const conflictingPayload = {
      ...validPayload,
      supported_parameters: ['temperature', 'presence_penalty'],
    };

    // Mock DB check for provider existence (Gemini)
    (db.query as jest.Mock).mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'provider-123', kind: 'gemini' }],
    });

    const res = await request(app).post('/api/model/provider-models').send(conflictingPayload);

    expect(res.status).toBe(400);
    expect((res.body as any).error.code).toBe('invalid_request');
    expect((res.body as any).error.message).toContain('does not natively support');
    expect((res.body as any).error.message).toContain('presence_penalty');
  });

  it('should successfully update a provider model with new parameters', async () => {
    // 1. Mock DB read for model_type
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ model_type: 'embedding' }] });
    // 2. Mock DB read for provider kind (cross-validation)
    (db.query as jest.Mock).mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ provider_id: 'provider-123', kind: 'gemini' }],
    });
    // 3. Mock DB update
    (db.query as jest.Mock).mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: 'model-embed',
          model_type: 'embedding',
          supported_parameters: ['dimensions'],
        },
      ],
    });

    const res = await request(app)
      .patch('/api/model/provider-models/model-embed')
      .send({
        supported_parameters: ['dimensions'],
      });

    expect(res.status).toBe(200);
  });
});

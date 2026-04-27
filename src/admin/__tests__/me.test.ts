import express from 'express';
import request from 'supertest';
import { findUserById } from '@/db';
import { meRouter } from '../me';

jest.mock('@/db', () => ({
  findUserById: jest.fn(),
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

const mockFindUserById = findUserById as jest.MockedFunction<typeof findUserById>;

const app = express();
app.use(express.json());
// Inject userId into res.locals (simulates adminAuth middleware)
app.use((_req, res, next) => {
  res.locals.userId = 'test-user-id';
  next();
});
app.use('/api/me', meRouter);

describe('GET /api/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return user info when userId is valid and user exists', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'test-user-id',
      username: 'testuser',
      email: 'test@example.com',
      avatar_data: '',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: 'user',
      id: 'test-user-id',
      username: 'testuser',
      email: 'test@example.com',
      avatar_url: '',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('should return avatar_url when user has avatar_data', async () => {
    mockFindUserById.mockResolvedValue({
      id: 'test-user-id',
      username: 'avataruser',
      email: 'avatar@example.com',
      avatar_data: 'base64-avatar-data',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).avatar_url).toBe('/api/users/test-user-id/avatar');
  });

  it('should return 401 when userId is missing', async () => {
    // Override the userId injection
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use('/api/me', meRouter);

    const res = await request(bareApp).get('/api/me');

    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).error).toEqual(
      expect.objectContaining({ code: 'unauthorized' }) as unknown,
    );
  });

  it('should return 404 when user does not exist', async () => {
    mockFindUserById.mockResolvedValue(null);

    const res = await request(app).get('/api/me');

    expect(res.status).toBe(404);
    expect((res.body as Record<string, unknown>).error).toEqual(
      expect.objectContaining({ code: 'not_found' }) as unknown,
    );
  });

  it('should return 500 when findUserById throws', async () => {
    mockFindUserById.mockRejectedValue(new Error('DB connection error'));

    const res = await request(app).get('/api/me');

    expect(res.status).toBe(500);
    expect((res.body as Record<string, unknown>).error).toEqual(
      expect.objectContaining({ code: 'internal_error' }) as unknown,
    );
  });
});

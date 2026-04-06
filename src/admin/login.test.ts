import express from 'express';
import request from 'supertest';
import { findByEmail } from '@/db';
import { signToken, verifyPassword } from '@/utils';
import { loginRouter } from './login';

jest.mock('@/db', () => ({
  findByEmail: jest.fn(),
}));

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  verifyPassword: jest.fn(),
  signToken: jest.fn(),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

const app = express();
app.use(express.json());
app.use('/api', loginRouter);

describe('POST /api/login', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  const validPayload = { email: 'admin@example.com', password: 'password123' };

  it('should return 400 if email or password is missing', async () => {
    const res1 = await request(app).post('/api/login').send({ email: 'admin@example.com' });
    expect(res1.status).toBe(400);
    expect((res1.body as { error: { code: string } }).error.code).toBe('bad_request');

    const res2 = await request(app).post('/api/login').send({ password: 'password123' });
    expect(res2.status).toBe(400);

    const res3 = await request(app).post('/api/login').send({ email: '', password: '' });
    expect(res3.status).toBe(400);
  });

  it('should return 500 if JWT_SECRET is not configured', async () => {
    process.env.JWT_SECRET = '';
    const res = await request(app).post('/api/login').send(validPayload);
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('config_error');
  });

  it('should return 401 if user is not found', async () => {
    (findByEmail as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post('/api/login').send(validPayload);
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('should return 401 if user is inactive', async () => {
    (findByEmail as jest.Mock).mockResolvedValue({ id: '1', is_active: false });
    const res = await request(app).post('/api/login').send(validPayload);
    expect(res.status).toBe(401);
  });

  it('should return 401 if password verification fails', async () => {
    (findByEmail as jest.Mock).mockResolvedValue({ id: '1', is_active: true, password_hash: 'hash' });
    (verifyPassword as jest.Mock).mockReturnValue(false);

    const res = await request(app).post('/api/login').send(validPayload);
    expect(verifyPassword).toHaveBeenCalledWith('password123', 'hash');
    expect(res.status).toBe(401);
  });

  it('should return 200 and access token if credentials are valid', async () => {
    (findByEmail as jest.Mock).mockResolvedValue({ id: 'user-123', is_active: true, password_hash: 'hash' });
    (verifyPassword as jest.Mock).mockReturnValue(true);
    (signToken as jest.Mock).mockReturnValue('mock-jwt-token');

    const res = await request(app).post('/api/login').send(validPayload);

    expect(signToken).toHaveBeenCalledWith({ sub: 'user-123' }, 'test-secret', 86_400);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token: 'mock-jwt-token',
      expires_in: 86_400,
      token_type: 'Bearer',
    });
  });

  it('should return 500 on unexpected errors', async () => {
    (findByEmail as jest.Mock).mockRejectedValue(new Error('DB Error'));
    const res = await request(app).post('/api/login').send(validPayload);
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal_error');
  });
});

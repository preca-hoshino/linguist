import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '@/utils';
import { adminAuth } from '../auth';

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  verifyToken: jest.fn(),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

describe('adminAuth middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      ip: '127.0.0.1',
      path: '/api/admin',
      method: 'GET',
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: {},
    };
    mockNext = jest.fn() as NextFunction;
    process.env.JWT_SECRET = 'test-secret';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('should return 500 if JWT_SECRET is not configured', () => {
    process.env.JWT_SECRET = '';
    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'config_error' }) as unknown,
    });
    expect(mockNext).not.toHaveBeenCalled();

    delete process.env.JWT_SECRET;
    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);
    expect(mockResponse.status).toHaveBeenCalledWith(500);
  });

  it('should return 401 if Authorization header is missing', () => {
    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'unauthorized',
        message: 'Missing or invalid Authorization header',
      }) as unknown,
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if header does not start with Bearer', () => {
    mockRequest.headers = { authorization: 'Basic xyz' };
    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 if token is invalid or expired', () => {
    mockRequest.headers = { authorization: 'Bearer invalid-token' };
    (verifyToken as jest.Mock).mockReturnValue(null);

    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(verifyToken).toHaveBeenCalledWith('invalid-token', 'test-secret');
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'unauthorized', message: 'Invalid or expired token' }) as unknown,
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should call next and set res.locals.userId if valid', () => {
    mockRequest.headers = { authorization: 'Bearer valid-token' };
    (verifyToken as jest.Mock).mockReturnValue({ sub: 'user-id-123' });

    adminAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(verifyToken).toHaveBeenCalledWith('valid-token', 'test-secret');
    expect(mockResponse.locals?.userId).toBe('user-id-123');
    expect(mockNext).toHaveBeenCalled();
  });
});

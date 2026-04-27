import type { Response } from 'express';
import { GatewayError } from '@/utils';
import { handleAdminError } from '../error';

jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));

function mockResponse(): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('handleAdminError', () => {
  let res: Partial<Response>;

  beforeEach(() => {
    res = mockResponse();
  });

  // ---- GatewayError ----

  it('should handle 401 GatewayError as authentication_error', () => {
    const err = new GatewayError(401, 'unauthorized', 'Invalid token');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'unauthorized', message: 'Invalid token', type: 'authentication_error', param: null },
    });
  });

  it('should handle 403 GatewayError as authentication_error', () => {
    const err = new GatewayError(403, 'forbidden', 'Access denied');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'forbidden', message: 'Access denied', type: 'authentication_error', param: null },
    });
  });

  it('should handle 404 GatewayError as not_found_error', () => {
    const err = new GatewayError(404, 'not_found', 'Resource not found');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'Resource not found', type: 'not_found_error', param: null },
    });
  });

  it('should handle 409 GatewayError as conflict_error', () => {
    const err = new GatewayError(409, 'conflict', 'Already exists');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'conflict', message: 'Already exists', type: 'conflict_error', param: null },
    });
  });

  it('should handle 500+ GatewayError as server_error', () => {
    const err = new GatewayError(500, 'internal', 'Server error');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'internal', message: 'Server error', type: 'server_error', param: null },
    });
  });

  it('should handle 400 GatewayError as invalid_request_error', () => {
    const err = new GatewayError(400, 'bad_request', 'Bad input');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'bad_request', message: 'Bad input', type: 'invalid_request_error', param: null },
    });
  });

  // ---- PostgreSQL errors ----

  it('should handle foreign key violation (23503)', () => {
    const pgErr = { code: '23503', table: 'model_providers', detail: 'Key not found' };
    handleAdminError(pgErr, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'invalid_reference',
        message: 'Foreign key constraint violation on table model_providers: referenced record does not exist.',
        type: 'invalid_request_error',
        param: null,
      },
    });
  });

  it('should handle foreign key violation with unknown table', () => {
    const pgErr = { code: '23503' };
    handleAdminError(pgErr, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining('unknown') as unknown,
        }) as unknown,
      }),
    );
  });

  it('should handle unique constraint violation (23505)', () => {
    const pgErr = { code: '23505', table: 'users' };
    handleAdminError(pgErr, res as Response);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'conflict_error',
        message: 'Unique constraint violation on table users.',
        type: 'conflict_error',
        param: null,
      },
    });
  });

  it('should handle unique constraint violation with unknown table', () => {
    const pgErr = { code: '23505' };
    handleAdminError(pgErr, res as Response);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining('unknown') as unknown,
        }) as unknown,
      }),
    );
  });

  // ---- Generic / unknown errors ----

  it('should handle generic Error as internal_error', () => {
    const err = new Error('Something went wrong');
    handleAdminError(err, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error', type: 'server_error', param: null },
    });
  });

  it('should handle non-Error unknown values as internal_error', () => {
    handleAdminError('string error', res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'internal_error', message: 'Internal server error', type: 'server_error', param: null },
    });
  });

  it('should handle null error as internal_error', () => {
    handleAdminError(null, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('should handle undefined error as internal_error', () => {
    handleAdminError(undefined, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('should handle object with unknown pg code as internal_error', () => {
    const pgErr = { code: '99999', table: 'some_table' };
    handleAdminError(pgErr, res as Response);

    // Falls through to the generic handler
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

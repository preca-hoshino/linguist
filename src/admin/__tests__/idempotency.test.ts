import type { NextFunction, Request, Response } from 'express';
import { db } from '@/db';
import { idempotencyMiddleware } from '../idempotency';

jest.mock('@/db', () => ({
  db: {
    query: jest.fn(),
  },
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

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;

function mockReq(opts?: { method?: string; idempotencyKey?: string; path?: string }): Partial<Request> {
  return {
    method: opts?.method ?? 'POST',
    path: opts?.path ?? '/api/test',
    header: jest.fn((name: string) => {
      if (name === 'idempotency-key') {
        return opts?.idempotencyKey ?? undefined;
      }
      return undefined;
    }) as unknown as Request['header'],
  };
}

function mockRes(): Partial<Response> {
  const res: Partial<Response> = {
    statusCode: 200,
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
}

describe('idempotencyMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  // ---- skip conditions ----

  it('should call next for non-POST requests', async () => {
    req = mockReq({ method: 'GET', idempotencyKey: 'key-1' });
    res = mockRes();

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should call next when idempotency-key header is missing', async () => {
    req = mockReq({ method: 'POST' });
    res = mockRes();

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should call next when idempotency-key header is empty string', async () => {
    req = mockReq({ method: 'POST', idempotencyKey: '' });
    res = mockRes();

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ---- idempotency key hit ----

  it('should return stored response on idempotency key hit', async () => {
    req = mockReq({ method: 'POST', idempotencyKey: 'existing-key' });
    res = mockRes();

    mockQuery.mockResolvedValueOnce({
      rows: [{ response_code: 201, response_body: { id: 'created', object: 'test' } }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 'created', object: 'test' });
    expect(next).not.toHaveBeenCalled();
  });

  // ---- first request: monkey-patches res.json ----

  it('should call next and patch res.json for first request', async () => {
    req = mockReq({ method: 'POST', idempotencyKey: 'new-key' });
    res = mockRes();

    // No existing idempotency key
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    // INSERT for storing response
    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    });

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();

    // Now call the patched res.json — it should store the response
    await (res.json as jest.Mock)('{"result":"ok"}');

    // Wait for async INSERT
    await new Promise((r) => setImmediate(r));

    // Verify the INSERT was triggered
    const insertCalls = mockQuery.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO'));
    expect(insertCalls.length).toBe(1);
  });

  // ---- error handling for INSERT failure ----

  it('should not throw if storing idempotency response fails', async () => {
    req = mockReq({ method: 'POST', idempotencyKey: 'new-key' });
    res = mockRes();

    mockQuery.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    // INSERT fails
    mockQuery.mockRejectedValueOnce(new Error('Insert failed'));

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();

    // Call patched res.json — the insert failure should be caught silently
    (res.json as jest.Mock)('{"result":"ok"}');

    await new Promise((r) => setImmediate(r));
    // Should not throw
  });

  // ---- DB lookup failure ----

  it('should call next with error when initial DB query fails', async () => {
    req = mockReq({ method: 'POST', idempotencyKey: 'key-1' });
    res = mockRes();

    const dbError = new Error('Connection lost');
    mockQuery.mockRejectedValueOnce(dbError);

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

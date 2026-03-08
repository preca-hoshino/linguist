import { GatewayError } from '../src/utils/errors';
import { handleError } from '../src/users/error-formatting';

// Mock logger to prevent output during tests
jest.mock('../src/utils/logger', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  logColors: {
    bold: '',
    red: '',
    green: '',
    yellow: '',
    blue: '',
    magenta: '',
    cyan: '',
    white: '',
  },
  __esModule: true,
}));

describe('GatewayError', () => {
  it('should create an error with statusCode, errorCode, and message', () => {
    const err = new GatewayError(400, 'invalid_model', 'Model not found');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.name).toBe('GatewayError');
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('invalid_model');
    expect(err.message).toBe('Model not found');
  });

  it('should preserve prototype chain for instanceof checks', () => {
    const err = new GatewayError(500, 'internal', 'Something went wrong');

    expect(err instanceof GatewayError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('handleError', () => {
  function createMockRes() {
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(data: unknown) {
        res.body = data;
        return res;
      },
    };
    return res;
  }

  it('should handle GatewayError with correct status and structure', () => {
    const err = new GatewayError(404, 'model_not_found', 'Model gpt-5 not found');
    const res = createMockRes();

    handleError(err, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'model_not_found',
        message: 'Model gpt-5 not found',
        type: 'gateway_error',
      },
    });
  });

  it('should handle GatewayError 400 for stream not supported', () => {
    const err = new GatewayError(400, 'stream_not_supported', 'Streaming is not supported');
    const res = createMockRes();

    handleError(err, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('stream_not_supported');
  });

  it('should handle generic Error as 500 internal_error', () => {
    const err = new Error('Unexpected failure');
    const res = createMockRes();

    handleError(err, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Unexpected failure',
        type: 'internal_error',
      },
    });
  });

  it('should handle non-Error thrown values', () => {
    const res = createMockRes();

    handleError('string error', res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error.message).toBe('string error');
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { GatewayError } from '@/utils/errors';
import { buildErrorResponseBody, handleError, registerErrorBodyBuilder } from '../error-handler';

jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
  logColors: { bold: '', red: '' },
}));

// Mock user-format error builders
jest.mock('../anthropic/error-formatting', () => ({
  buildAnthropicErrorBody: jest.fn(() => ({ status: 400, body: { type: 'anthropic-error' } })),
}));

jest.mock('../gemini/error-formatting', () => ({
  buildGeminiErrorBody: jest.fn(() => ({ status: 400, body: { code: 400 } })),
}));

jest.mock('../openaicompat/error-formatting', () => ({
  buildOpenAICompatErrorBody: jest.fn(() => ({ status: 500, body: { error: { message: 'oai' } } })),
}));

describe('buildErrorResponseBody', () => {
  it('should use openaicompat builder as default when format is undefined', () => {
    const result = buildErrorResponseBody(new Error('test'));
    expect(result.body).toMatchObject({ error: { message: 'oai' } });
  });

  it('should use openaicompat builder when format is undefined explicitly', () => {
    const result = buildErrorResponseBody(new Error('test'), undefined);
    expect(result.body).toMatchObject({ error: { message: 'oai' } });
  });

  it('should use registered builder for known format', () => {
    const result = buildErrorResponseBody(new Error('test'), 'gemini');
    expect(result.body).toMatchObject({ code: 400 });
  });

  it('should use registered builder for anthropic format', () => {
    const result = buildErrorResponseBody(new Error('test'), 'anthropic');
    expect(result.body).toMatchObject({ type: 'anthropic-error' });
  });

  it('should fall back to openaicompat builder for unregistered format', () => {
    const result = buildErrorResponseBody(new Error('test'), 'unknown-format');
    expect(result.body).toMatchObject({ error: { message: 'oai' } });
  });
});

describe('registerErrorBodyBuilder', () => {
  it('should allow registering and using a custom format builder', () => {
    const customBuilder = jest.fn(() => ({ status: 418, body: { teapot: true } }));
    registerErrorBodyBuilder('custom', customBuilder);
    const result = buildErrorResponseBody(new Error('custom'), 'custom');
    expect(result.body).toMatchObject({ teapot: true });
    expect(customBuilder).toHaveBeenCalled();
  });
});

describe('handleError', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('should log with warn level and send response for GatewayError', () => {
    const err = new GatewayError(400, 'bad_request', 'Bad');
    handleError(err, mockRes as any, 'openaicompat');
    expect(mockRes.status).toHaveBeenCalledWith(500); // from mocked builder
    expect(mockRes.json).toHaveBeenCalled();
  });

  it('should log with error level for unexpected error', () => {
    handleError(new Error('unexpected'), mockRes as any);
    expect(mockRes.status).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalled();
  });
});

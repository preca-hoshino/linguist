import type { Request, Response } from 'express';
import { getApiKeyExtractor, getFormatLogger } from '@/api';
import { markCompleted, markError, markProcessing } from '@/db';
import { applyMiddlewares } from '@/middleware';
import { dispatchChatProvider, dispatchEmbeddingProvider } from '@/model/http/providers/engine';
import { assertRouted, route } from '@/model/http/router';
import { buildErrorResponseBody, getUserChatAdapter, getUserEmbeddingAdapter, handleError } from '@/model/http/users';
import { processChatCompletion, processEmbedding } from '../process';
import { processStreamSend } from '../stream';

jest.mock('@/model/http/providers/engine');
jest.mock('@/middleware');
jest.mock('@/model/http/router');
jest.mock('@/db');
jest.mock('../stream');

// Mock `users` module but keep actual types if needed
jest.mock('@/model/http/users', () => ({
  getUserChatAdapter: jest.fn(),
  getUserEmbeddingAdapter: jest.fn(),
  handleError: jest.fn(),
  buildErrorResponseBody: jest.fn().mockReturnValue({ body: { error: 'test' } }),
}));

// Mock `api` module
jest.mock('@/api', () => ({
  getApiKeyExtractor: jest.fn(),
  getFormatLogger: jest.fn(),
}));

describe('Process Flow', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;

  beforeEach(() => {
    jest.resetAllMocks();

    mockReq = {
      ip: '127.0.0.1',
      method: 'POST',
      path: '/model/openai-compat/v1/chat/completions',
      headers: { 'user-agent': 'jest' },
      body: { model: 'test-model' },
    } as unknown as jest.Mocked<Request>;

    mockRes = {
      json: jest.fn(),
      end: jest.fn(),
      getHeaders: jest.fn().mockReturnValue({}),
      headersSent: false,
    } as unknown as jest.Mocked<Response>;

    const mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    (getFormatLogger as jest.Mock).mockReturnValue(mockLogger);
    (getApiKeyExtractor as jest.Mock).mockReturnValue(() => 'sk-test-key-123456');
    (buildErrorResponseBody as jest.Mock).mockReturnValue({ body: { error: 'test' } });

    (markProcessing as jest.Mock).mockResolvedValue(true);
    (markCompleted as jest.Mock).mockResolvedValue(true);
    (markError as jest.Mock).mockResolvedValue(true);
  });

  describe('processChatCompletion', () => {
    it('should successfully process a non-stream request', async () => {
      const fromInternalMock = jest.fn().mockReturnValue({ result: 'success' });
      (getUserChatAdapter as jest.Mock).mockReturnValue({
        request: { toInternal: jest.fn().mockReturnValue({ stream: false }) },
        response: { fromInternal: fromInternalMock },
      });
      (dispatchChatProvider as jest.Mock).mockResolvedValue(undefined);

      await processChatCompletion(mockReq, mockRes, 'openai', 'test-model');

      expect(getApiKeyExtractor).toHaveBeenCalledWith('openai');
      expect(getUserChatAdapter).toHaveBeenCalledWith('openai');
      // Request adapter
      expect(applyMiddlewares).toHaveBeenCalledTimes(3); // request + postRoute(rateLimit) + response
      expect(route).toHaveBeenCalled();
      expect(assertRouted).toHaveBeenCalled();
      expect(markProcessing).toHaveBeenCalled();

      expect(dispatchChatProvider).toHaveBeenCalled();

      expect(fromInternalMock).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ result: 'success' });
      expect(markCompleted).toHaveBeenCalled();
    });

    it('should route to processStreamSend if stream is true', async () => {
      (getUserChatAdapter as jest.Mock).mockReturnValue({
        request: { toInternal: jest.fn().mockReturnValue({ stream: true }) },
      });

      await processChatCompletion(mockReq, mockRes, 'openai', 'test-model');

      expect(processStreamSend).toHaveBeenCalled();
      expect(dispatchChatProvider).not.toHaveBeenCalled();
      expect(markCompleted).toHaveBeenCalled();
    });

    it('should catch errors and call handleError', async () => {
      const testError = new Error('Test error');
      (getUserChatAdapter as jest.Mock).mockReturnValue({
        request: { toInternal: jest.fn().mockReturnValue({ stream: false }) },
      });
      (applyMiddlewares as jest.Mock).mockRejectedValueOnce(testError);

      await processChatCompletion(mockReq, mockRes, 'openai', 'test-model');

      expect(handleError).toHaveBeenCalledWith(testError, mockRes, 'openai');
      expect(markError).toHaveBeenCalled();
    });

    it('should end response if error occurs during streaming and headers sent', async () => {
      mockRes.headersSent = true;
      const testError = new Error('Stream error');
      (getUserChatAdapter as jest.Mock).mockReturnValue({
        request: { toInternal: jest.fn().mockReturnValue({ stream: true }) },
      });
      (processStreamSend as jest.Mock).mockRejectedValueOnce(testError);

      await processChatCompletion(mockReq, mockRes, 'openai', 'test-model');

      expect(mockRes.end).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
      expect(markError).toHaveBeenCalled();
    });
  });

  describe('processEmbedding', () => {
    it('should successfully process an embedding request', async () => {
      const fromInternalMock = jest.fn().mockReturnValue({ embedding: [0.1, 0.2] });
      (getUserEmbeddingAdapter as jest.Mock).mockReturnValue({
        request: { toInternal: jest.fn().mockReturnValue({}) },
        response: { fromInternal: fromInternalMock },
      });
      (dispatchEmbeddingProvider as jest.Mock).mockResolvedValue(undefined);

      await processEmbedding(mockReq, mockRes, 'openai', 'test-model');

      expect(getUserEmbeddingAdapter).toHaveBeenCalledWith('openai');
      expect(dispatchEmbeddingProvider).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ embedding: [0.1, 0.2] });
      expect(markCompleted).toHaveBeenCalled();
    });
  });
});

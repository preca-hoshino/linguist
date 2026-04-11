import { fetchHeadersToRecord, parseProviderResponse } from '../http-utils';
import { GatewayError } from '@/utils';
import type { Logger } from '@/utils/logger';

describe('Providers HTTP Utils', () => {
  describe('fetchHeadersToRecord', () => {
    it('应该提取 Headers 为普通对象', () => {
      const headers = new Headers();
      headers.set('x-foo', 'bar');
      headers.set('content-type', 'application/json');
      expect(fetchHeadersToRecord(headers)).toEqual({
        'x-foo': 'bar',
        'content-type': 'application/json',
      });
    });
  });

  describe('parseProviderResponse', () => {
    const dummyLogger = {
      debug: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    it('如果 status OK，应该返回 body 和 headers', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-test': 'value' }),
        json: async () => await Promise.resolve({ data: 'ok' }),
      } as unknown as Response;

      const result = await parseProviderResponse(
        mockResponse,
        'test_provider',
        dummyLogger,
        { duration: 100 },
        jest.fn(),
      );
      expect(result.body).toEqual({ data: 'ok' });
      expect(result.responseHeaders).toEqual({ 'x-test': 'value' });
    });

    it('如果 status 不为 OK，应该捕获并抛出 GatewayError', async () => {
      const mockResponse = {
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => await Promise.resolve('error body'),
      } as unknown as Response;

      const mockMapError = jest.fn().mockReturnValue({
        gatewayStatusCode: 400,
        gatewayErrorCode: 'invalid_request',
        providerErrorCode: 'custom_err',
        message: 'Something went wrong',
      });

      await expect(
        parseProviderResponse(mockResponse, 'test_provider', dummyLogger, { duration: 100 }, mockMapError),
      ).rejects.toThrow(GatewayError);

      expect(mockMapError).toHaveBeenCalledWith(400, 'error body');
    });
  });
});

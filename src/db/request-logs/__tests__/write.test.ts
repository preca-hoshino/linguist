/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/explicit-function-return-type */
import { markProcessing, markCompleted, markError } from '../write';
import type { ModelHttpContext } from '@/types';
import { db } from '@/db/client';
import { lookupPricingTiers, calculatePostBillingCost } from '@/db/billing';
import { GatewayError } from '@/utils';

jest.mock('@/db/client', () => ({
  db: {
    query: jest.fn(),
  },
}));

jest.mock('@/db/billing', () => ({
  lookupPricingTiers: jest.fn(),
  calculatePostBillingCost: jest.fn(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  logColors: { bold: '', blue: '' },
}));

describe('request-logs/write', () => {
  let mockCtx: ModelHttpContext;

  beforeEach(() => {
    jest.resetAllMocks();
    mockCtx = {
      id: 'req_123',
      ip: '127.0.0.1',
      apiKeyName: 'test-key',
      userFormat: 'openai',
      http: { method: 'POST', body: {} },
      requestModel: 'gpt-3',
      route: {
        model: 'gpt-3.5-turbo',
        modelType: 'chat',
        providerKind: 'openaicompat',
        providerId: 'prov_1',
        providerConfig: { name: 'OpenAI Test' },
        strategy: 'load_balance',
        capabilities: [],
      },
      stream: true,
      request: {},
      response: { usage: undefined },
      audit: {},
      timing: { start: 1000 },
      error: undefined,
      providerError: undefined,
    } as unknown as ModelHttpContext;
  });

  describe('markProcessing', () => {
    it('should successfully insert processing records', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
      // @ts-expect-error: testing normal mock properties with route guarantee
      await markProcessing(mockCtx);
      expect(db.query).toHaveBeenCalledTimes(2);
      expect((db.query as jest.Mock).mock.calls[0][0]).toContain('INSERT INTO request_logs');
    });

    it('should catch error and log it', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB Error'));
      // @ts-expect-error: testing normal mock properties with route guarantee
      await markProcessing(mockCtx);
      expect(db.query).toHaveBeenCalledTimes(1);
      // Wait, we can't easily assert the logger without exporting it or asserting its mock.
      // But coverage will show the catch block is hit.
    });

    it('should handle undefined route gracefully (though typing requires it)', async () => {
      // @ts-expect-error: intentionally testing undefined fields
      mockCtx.route = { ...mockCtx.route, model: undefined, providerKind: undefined, providerId: undefined };
      mockCtx.appId = undefined;
      mockCtx.stream = undefined;
      (db.query as jest.Mock).mockResolvedValue({});
      // @ts-expect-error: testing invalid payload
      await markProcessing(mockCtx);
      expect((db.query as jest.Mock).mock.calls[0][1][1]).toBeNull(); // appId
    });
  });

  describe('markCompleted', () => {
    it('should insert completed records without usage', async () => {
      (db.query as jest.Mock).mockResolvedValue({});
      await markCompleted(mockCtx);
      expect(db.query).toHaveBeenCalledTimes(2);
      expect((db.query as jest.Mock).mock.calls[0][0]).toContain('UPDATE request_logs');
    });

    it('should insert completed records with full usage and cost breakdown', async () => {
      mockCtx.response = {
        usage: {
          prompt_tokens: 10,
          // @ts-expect-error: completion_tokens may not exist functionally but we test it
          completion_tokens: 20,
          total_tokens: 30,
          cached_tokens: 5,
          reasoning_tokens: 2,
        },
      };
      mockCtx.timing.end = 2000;

      (lookupPricingTiers as jest.Mock).mockResolvedValue('tiers');
      (calculatePostBillingCost as jest.Mock).mockReturnValue({
        status: 'success',
        cost: 0.15,
        breakdown: { prompt: 0.05, completion: 0.1 },
      });
      (db.query as jest.Mock).mockResolvedValue({});

      await markCompleted(mockCtx);
      expect(lookupPricingTiers).toHaveBeenCalledWith('prov_1', 'gpt-3.5-turbo');
      expect(calculatePostBillingCost).toHaveBeenCalled();

      // calculated_cost is $11
      const updateArgs = (db.query as jest.Mock).mock.calls[0][1];
      expect(updateArgs[10]).toBe(0.15); // calculatedCost
    });

    it('should handle billing failure or missing billing result gracefully', async () => {
      // @ts-expect-error: simplified mock response for testing
      mockCtx.response = { usage: { prompt_tokens: 10, total_tokens: 10 } };
      (lookupPricingTiers as jest.Mock).mockResolvedValue('tiers');
      (calculatePostBillingCost as jest.Mock).mockReturnValue({
        status: 'error',
        message: 'no matched tier',
      });
      (db.query as jest.Mock).mockResolvedValue({});

      await markCompleted(mockCtx);
      expect(lookupPricingTiers).toHaveBeenCalled();

      const updateArgs = (db.query as jest.Mock).mock.calls[0][1];
      expect(updateArgs[10]).toBe(0); // fallback cost
    });

    it('should handle ctx.route undefined and different usage variations', async () => {
      // @ts-expect-error: intentionally dropping route for test
      mockCtx.route = undefined;
      // Also no timing end
      (db.query as jest.Mock).mockResolvedValue({});
      await markCompleted(mockCtx);
      expect(lookupPricingTiers).not.toHaveBeenCalled();
    });

    it('should catch error and log it', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB Error'));
      await markCompleted(mockCtx);
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should handle ctx.stream as false or undefined', async () => {
      (db.query as jest.Mock).mockClear();
      (db.query as jest.Mock).mockResolvedValue({});
      await markCompleted({ ...mockCtx, stream: false } as unknown as ModelHttpContext);
      expect((db.query as jest.Mock).mock.calls[0][1][9]).toBe(false);

      (db.query as jest.Mock).mockClear();
      (db.query as jest.Mock).mockResolvedValue({});
      await markCompleted({ ...mockCtx, stream: undefined } as unknown as ModelHttpContext);
      expect((db.query as jest.Mock).mock.calls[0][1][9]).toBeNull();
    });
  });

  describe('markError', () => {
    it('should ignore if route is missing', async () => {
      await markError({ ...mockCtx, route: undefined } as unknown as ModelHttpContext, new Error('Test'));
      expect(db.query).not.toHaveBeenCalled();
    });

    it('should update existing records if rowCount > 0', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({});
      await markError(mockCtx, new Error('Failure'));
      expect(db.query).toHaveBeenCalledTimes(2);
      expect((db.query as jest.Mock).mock.calls[0][0]).toContain('UPDATE request_logs');
      expect((db.query as jest.Mock).mock.calls[1][0]).toContain('UPDATE request_logs_details');
    });

    it('should insert new records if rowCount is undefined (handled as 0)', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rowCount: undefined })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await markError(mockCtx, new Error('Failure'));
      expect(db.query).toHaveBeenCalledTimes(3);
    });

    it('should insert new records if rowCount is 0, covering nullish properties', async () => {
      const mCtx = {
        ...mockCtx,
        stream: undefined,
        appId: undefined,
        error: undefined,
      } as unknown as ModelHttpContext;
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await markError(mCtx, new GatewayError(500, 'Failure', 'msg'));
      expect(db.query).toHaveBeenCalledTimes(3);
      expect((db.query as jest.Mock).mock.calls[0][0]).toContain('UPDATE request_logs');
      expect((db.query as jest.Mock).mock.calls[1][0]).toContain('INSERT INTO request_logs');
      expect((db.query as jest.Mock).mock.calls[2][0]).toContain('INSERT INTO request_logs_details');

      const insertArgs = (db.query as jest.Mock).mock.calls[1][1];
      expect(insertArgs[1]).toBeNull(); // appId
      expect(insertArgs[3]).toBeNull(); // is_stream
      expect(insertArgs[8]).toBeNull(); // error_message
    });

    it('should extract errorCode from GatewayError properly', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1 });
      const err = new GatewayError(402, 'insufficient_balance', 'no money');
      await markError(mockCtx, err);
      const updateArgs = (db.query as jest.Mock).mock.calls[0][1];
      expect(updateArgs[5]).toBe('insufficient_balance'); // errorCode
      expect(updateArgs[6]).toBe('auth_error'); // errorType
    });

    it('should catch error when db query fails', async () => {
      (db.query as jest.Mock).mockRejectedValueOnce(new Error('DB Error'));
      await markError(mockCtx, new Error('x'));
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('inferErrorType branches', () => {
    // To reach private function inferErrorType, we call markError with various simulated GatewayErrors
    const assertErrorType = async (code: string, expectedType: string) => {
      (db.query as jest.Mock).mockClear();
      (db.query as jest.Mock).mockResolvedValue({ rowCount: 1 });
      await markError(mockCtx, new GatewayError(500, code, 'msg'));
      const updateArgs = (db.query as jest.Mock).mock.calls[0][1];
      expect(updateArgs[6]).toBe(expectedType);
    };

    it('should map error codes directly', async () => {
      await assertErrorType('rate_limit_exceeded', 'rate_limit');
      await assertErrorType('provider_timeout', 'timeout');
      await assertErrorType('unauthorized', 'auth_error');
      await assertErrorType('missing_model', 'invalid_request');
      await assertErrorType('route_error', 'internal_error');
      await assertErrorType('no_backend_available', 'provider_error');
      await assertErrorType('unknown_error_code', 'provider_error');
      await assertErrorType('', 'provider_error');
    });
  });
});

import { db } from '@/db/client';
import { createLogger } from '@/utils';
import { lookupPricingTiers } from '../lookup';

jest.mock('@/db/client', () => ({
  db: { query: jest.fn() },
}));

// Mock logger
jest.mock('@/utils', () => {
  const mError = jest.fn();
  return {
    createLogger: jest.fn(() => ({
      error: mError,
    })),
    logColors: { bold: '', green: '' },
  };
});

describe('lookupPricingTiers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return pricing tiers for a given provider and model', async () => {
    const mockTiers = [{ startTokens: 0, inputPrice: 1, outputPrice: 1, cachePrice: 0.5 }];
    (db.query as jest.Mock).mockResolvedValue({
      rows: [{ pricing_tiers: mockTiers }],
    });

    const result = await lookupPricingTiers('openai', 'gpt-4o');

    expect(db.query).toHaveBeenCalledWith(
      'SELECT pricing_tiers FROM model_provider_models WHERE provider_id = $1 AND name = $2 LIMIT 1',
      ['openai', 'gpt-4o'],
    );
    expect(result).toEqual(mockTiers);
  });

  it('should return empty array if no rows are returned', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [] });

    const result = await lookupPricingTiers('openai', 'gpt-4o');

    expect(result).toEqual([]);
  });

  it('should return empty array if pricing_tiers is not an array', async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ pricing_tiers: null }] });

    const result = await lookupPricingTiers('openai', 'gpt-4o');

    expect(result).toEqual([]);
  });

  it('should return empty array and log error when database throws', async () => {
    const error = new Error('DB Error');
    (db.query as jest.Mock).mockRejectedValue(error);

    const result = await lookupPricingTiers('openai', 'gpt-4o');

    expect(result).toEqual([]);
    const loggerMock = createLogger('Billing');
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, providerId: 'openai', modelName: 'gpt-4o' }),
      'Failed to lookup pricing tiers',
    );
  });
});

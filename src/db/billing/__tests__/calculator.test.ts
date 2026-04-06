import type { PricingTier } from '@/types';
import { calculatePostBillingCost } from '../calculator';

describe('calculatePostBillingCost', () => {
  const standardTier: PricingTier = {
    startTokens: 0,
    maxTokens: null,
    inputPrice: 10, // CNY 10 per 1M
    cachePrice: 5, // CNY 5 per 1M
    outputPrice: 20, // CNY 20 per 1M
  };

  const highTier: PricingTier = {
    startTokens: 128_000,
    maxTokens: null,
    inputPrice: 20, // CNY 20 per 1M
    cachePrice: 10, // CNY 10 per 1M
    outputPrice: 40, // CNY 40 per 1M
  };

  it('should skip computation if no tiers configured', () => {
    const result = calculatePostBillingCost([], 1000, 1000);
    expect(result).toEqual({ status: 'skipped', reason: 'no_tiers' });
  });

  it('should skip computation if no usage exists', () => {
    const result = calculatePostBillingCost([standardTier], 0, 0);
    expect(result).toEqual({ status: 'skipped', reason: 'no_usage' });
  });

  it('should calculate cost accurately for standard usage', () => {
    // 100k input, 50k output. No cache.
    // Cost: Input = (100k/1M)*10 = 1. Output = (50k/1M)*20 = 1
    const result = calculatePostBillingCost([standardTier], 100_000, 50_000);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.cost).toBe(2);
      expect(result.breakdown).toEqual({
        tierStartTokens: 0,
        inputCost: 1,
        cacheCost: 0,
        outputCost: 1,
      });
    }
  });

  it('should accurately factor in cached tokens', () => {
    // 100k input (where 40k is cached), 50k output.
    // Pure Input = 60k -> (60k/1M)*10 = 0.6
    // Cache = 40k -> (40k/1M)*5 = 0.2
    // Output = 50k -> (50k/1M)*20 = 1
    // Total = 1.8
    const result = calculatePostBillingCost([standardTier], 100_000, 50_000, 40_000);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.cost).toBe(1.8);
      expect(result.breakdown).toEqual({
        tierStartTokens: 0,
        inputCost: 0.6,
        cacheCost: 0.2,
        outputCost: 1,
      });
    }
  });

  it('should cap cachedTokens if it exceeds promptTokens', () => {
    // 100k input, but claims 150k cached. Should cap cache to 100k.
    // Pure = 0. Cache = 100k -> 0.5. Output = 0
    const result = calculatePostBillingCost([standardTier], 100_000, 0, 150_000);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.cost).toBe(0.5);
      expect(result.breakdown.inputCost).toBe(0);
      expect(result.breakdown.cacheCost).toBe(0.5);
    }
  });

  it('should select correct tier based on prompt width', () => {
    const tiers = [standardTier, highTier];

    // 130k input > 128k, should use highTier
    // Pure input = 130k -> (130k/1M)*20 = 2.6. Output = 0
    const result = calculatePostBillingCost(tiers, 130_000, 0);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.cost).toBe(2.6);
      expect(result.breakdown.tierStartTokens).toBe(128_000);
    }
  });

  it('should sort dynamically and fallback if required', () => {
    // Even if tiers are passed unsorted, it should find highest matching
    const unsortedTiers = [
      { startTokens: 200_000, maxTokens: null, inputPrice: 30, outputPrice: 60, cachePrice: 15 },
      { startTokens: 0, maxTokens: null, inputPrice: 10, outputPrice: 20, cachePrice: 5 },
      { startTokens: 100_000, maxTokens: null, inputPrice: 20, outputPrice: 40, cachePrice: 10 },
    ];

    const result = calculatePostBillingCost(unsortedTiers, 150_000, 0);

    // Should match startTokens: 100000 tier
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.breakdown.tierStartTokens).toBe(100_000);
    }
  });

  it('should fallback to smallest tier if input is less than all startTokens', () => {
    const tierFallback: PricingTier = {
      startTokens: 1000,
      maxTokens: null,
      inputPrice: 10,
      cachePrice: 5,
      outputPrice: 20,
    };

    // input: 500 < 1000, it should use the only tier available
    const result = calculatePostBillingCost([tierFallback], 500, 0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.breakdown.tierStartTokens).toBe(1000);
    }
  });
});

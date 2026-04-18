import type { PricingTier } from '@/types';
import { calculatePostBillingCost } from '../calculator';

describe('calculatePostBillingCost', () => {
  const standardTier: PricingTier = {
    start_tokens: 0,
    max_tokens: null,
    input_price: 10, // CNY 10 per 1M
    cache_price: 5, // CNY 5 per 1M
    output_price: 20, // CNY 20 per 1M
  };

  const highTier: PricingTier = {
    start_tokens: 128_000,
    max_tokens: null,
    input_price: 20, // CNY 20 per 1M
    cache_price: 10, // CNY 10 per 1M
    output_price: 40, // CNY 40 per 1M
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
      { start_tokens: 200_000, max_tokens: null, input_price: 30, output_price: 60, cache_price: 15 },
      { start_tokens: 0, max_tokens: null, input_price: 10, output_price: 20, cache_price: 5 },
      { start_tokens: 100_000, max_tokens: null, input_price: 20, output_price: 40, cache_price: 10 },
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
      start_tokens: 1000,
      max_tokens: null,
      input_price: 10,
      cache_price: 5,
      output_price: 20,
    };

    // input: 500 < 1000, it should use the only tier available
    const result = calculatePostBillingCost([tierFallback], 500, 0);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.breakdown.tierStartTokens).toBe(1000);
    }
  });
});

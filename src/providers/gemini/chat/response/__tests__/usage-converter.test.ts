import type { GeminiUsageMetadata } from '../types';
import { convertUsage } from '../usage-converter';

describe('Gemini Provider Usage Converter', () => {
  it('应该处理 undefined', () => {
    expect(convertUsage()).toBeUndefined();
  });

  it('应该转换基本字段并计算 default totalTokenCount', () => {
    const meta: GeminiUsageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
    };
    expect(convertUsage(meta)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30, // Default computed
    });
  });

  it('应该转换完整的带特有字段的结构', () => {
    const meta: GeminiUsageMetadata = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 155, // 超过 150
      thoughtsTokenCount: 10,
      cachedContentTokenCount: 5,
    };
    expect(convertUsage(meta)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 155,
      reasoning_tokens: 10,
      cached_tokens: 5,
    });
  });
});

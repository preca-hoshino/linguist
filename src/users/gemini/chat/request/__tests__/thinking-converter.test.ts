import { convertThinkingConfig } from '../thinking-converter';
import type { GeminiThinkingConfig } from '../types';

describe('Gemini Thinking Converter', () => {
  it('应该处理 undefined', () => {
    expect(convertThinkingConfig(undefined, 1000)).toBeUndefined();
  });

  it('应该优先使用 thinkingBudget', () => {
    const config: GeminiThinkingConfig = {
      thinkingBudget: 500,
      thinkingLevel: 'HIGH', // should be ignored
    };
    expect(convertThinkingConfig(config, 1000)).toEqual({
      type: 'enabled',
      budget_tokens: 500,
    });
  });

  it('应该根据 thinkingLevel 和 maxOutputTokens 计算 budget', () => {
    const config: GeminiThinkingConfig = {
      thinkingLevel: 'MEDIUM', // 50%
    };
    expect(convertThinkingConfig(config, 2000)).toEqual({
      type: 'enabled',
      budget_tokens: 1000,
    });
  });

  it('如果缺少 maxOutputTokens，不应该设置 budget_tokens', () => {
    const config: GeminiThinkingConfig = {
      thinkingLevel: 'HIGH',
    };
    expect(convertThinkingConfig(config)).toEqual({
      type: 'enabled',
      budget_tokens: undefined,
    });
  });

  it('如果 includeThoughts 为 false，type 应为 disabled', () => {
    const config: GeminiThinkingConfig = {
      thinkingLevel: 'MINIMAL', // 5%
      includeThoughts: false,
    };
    expect(convertThinkingConfig(config, 1000)).toEqual({
      type: 'disabled',
      budget_tokens: 50,
    });
  });

  it('如果 thinkingLevel 提供未知的等效值则 fallback 为 undefined', () => {
    const config: GeminiThinkingConfig = {
      thinkingLevel: 'UNKNOWN' as never,
    };
    expect(convertThinkingConfig(config, 1000)).toEqual({
      type: 'enabled',
      budget_tokens: undefined,
    });
  });

  it('如果 thinkingLevel 是空字符串，应忽略 level 计算', () => {
    const config: GeminiThinkingConfig = {
      thinkingLevel: '' as never,
    };
    expect(convertThinkingConfig(config, 1000)).toEqual({
      type: 'enabled',
      budget_tokens: undefined,
    });
  });
});

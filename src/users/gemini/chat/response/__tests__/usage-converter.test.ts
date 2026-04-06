import type { InternalChatResponse } from '@/types';
import { convertUsage } from '../usage-converter';

describe('Gemini Usage Converter', () => {
  it('应该处理 undefined', () => {
    expect(convertUsage()).toBeUndefined();
  });

  it('应该基本转换 prompt, completion, total', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    };
    expect(convertUsage(usage)).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    });
  });

  it('应该支持 reasoning_tokens 和 cached_tokens', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      reasoning_tokens: 10,
      cached_tokens: 40,
    };
    expect(convertUsage(usage)).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
      thoughtsTokenCount: 10,
      cachedContentTokenCount: 40,
    });
  });
});

import type { InternalChatResponse } from '@/types';
import { convertUsage } from '../usage-converter';

describe('OpenAICompat Usage Converter', () => {
  it('应该处理 undefined', () => {
    expect(convertUsage()).toBeUndefined();
  });

  it('应该转换基本字段', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    };
    expect(convertUsage(usage)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it('如果含有 cached_tokens，应组合出 prompt_tokens_details', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cached_tokens: 80,
    };
    expect(convertUsage(usage)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: {
        cached_tokens: 80,
      },
    });
  });

  it('如果含有 reasoning_tokens，应组合出 completion_tokens_details', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 50,
      completion_tokens: 100,
      total_tokens: 150,
      reasoning_tokens: 40,
    };
    expect(convertUsage(usage)).toEqual({
      prompt_tokens: 50,
      completion_tokens: 100,
      total_tokens: 150,
      completion_tokens_details: {
        reasoning_tokens: 40,
      },
    });
  });

  it('应该支持同时包含 cached 和 reasoning 的复合场景', () => {
    const usage: InternalChatResponse['usage'] = {
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
      cached_tokens: 40,
      reasoning_tokens: 60,
    };
    expect(convertUsage(usage)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 60 },
    });
  });
});

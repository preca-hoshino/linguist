import type { ChatUsage } from '@/types';
import { convertUsage } from '../usage-converter';

describe('Anthropic Response Usage Converter', () => {
  it('应该处理 undefined', () => {
    expect(convertUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('应该转换普通 usage 对象', () => {
    const usage: ChatUsage = {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    };
    expect(convertUsage(usage)).toEqual({
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it('应该转换带有 cached_tokens 的 usage 对象', () => {
    const usage: ChatUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cached_tokens: 80,
    };
    expect(convertUsage(usage)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
    });
  });
});

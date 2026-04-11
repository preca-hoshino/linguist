import type { InternalChatResponse } from '@/types';
import { convertCandidate } from '../candidate-converter';

describe('Gemini Candidate Converter', () => {
  it('应该只转换 content 且正确映射 finishReason为STOP', () => {
    const choice: InternalChatResponse['choices'][number] = {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'Hello World',
      },
    };
    expect(convertCandidate(choice)).toEqual({
      content: {
        role: 'model',
        parts: [{ text: 'Hello World' }],
      },
      finishReason: 'STOP',
    });
  });

  it('应该将 reasoning_content 作为 thought 且位于 text 之前', () => {
    const choice: InternalChatResponse['choices'][number] = {
      index: 0,
      finish_reason: 'length',
      message: {
        role: 'assistant',
        content: 'Finished thinking',
        reasoning_content: 'I should think first',
      },
    };
    expect(convertCandidate(choice)).toEqual({
      content: {
        role: 'model',
        parts: [{ text: 'I should think first', thought: true }, { text: 'Finished thinking' }],
      },
      finishReason: 'MAX_TOKENS',
    });
  });

  it('应该正确转换 tool_calls 为 functionCall parts 且 finishReason=STOP', () => {
    const choice: InternalChatResponse['choices'][number] = {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'getWeather', arguments: '{"q":"SF"}' },
          },
        ],
      },
    };
    expect(convertCandidate(choice)).toEqual({
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'getWeather',
              args: { q: 'SF' },
              id: 'call_1',
            },
          },
        ],
      },
      finishReason: 'STOP',
    });
  });

  it('应该处理只返回 reasoning 而 content 为空情况', () => {
    const choice: InternalChatResponse['choices'][number] = {
      index: 0,
      finish_reason: 'content_filter',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'This is unsafe',
      },
    };
    expect(convertCandidate(choice)).toEqual({
      content: {
        role: 'model',
        parts: [{ text: 'This is unsafe', thought: true }],
      },
      finishReason: 'SAFETY',
    });
  });
});

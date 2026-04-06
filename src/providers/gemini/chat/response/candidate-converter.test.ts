import { convertCandidate } from './candidate-converter';
import type { GeminiCandidate } from './types';

describe('Gemini Provider Candidate Converter', () => {
  it('应该拆分 text 和 thought 为 content 和 reasoning_content', () => {
    const candidate: GeminiCandidate = {
      content: {
        role: 'model',
        parts: [{ text: 'Let me think', thought: true }, { text: 'Final answer' }],
      },
      finishReason: 'STOP',
    };
    expect(convertCandidate(candidate, 0)).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Final answer',
        reasoning_content: 'Let me think',
      },
      finish_reason: 'stop',
    });
  });

  it('如果包含 functionCall，应该返回 tool_calls 且 content 为 null (如果没有 text)', () => {
    const candidate: GeminiCandidate = {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'f1', args: { a: 1 } } }, { functionCall: { name: 'f2', args: {} } }],
      },
      finishReason: 'STOP', // 将映射为 tool_calls
    };
    expect(convertCandidate(candidate, 1)).toEqual({
      index: 1,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1_0', type: 'function', function: { name: 'f1', arguments: '{"a":1}' } },
          { id: 'call_1_1', type: 'function', function: { name: 'f2', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('如果含有 finishReason 且无 tool_calls，则直接映射 fallback unknown', () => {
    const candidate: GeminiCandidate = {
      content: {
        role: 'model',
        parts: [{ text: 'Filtered' }],
      },
      finishReason: 'SAFETY',
    };
    expect(convertCandidate(candidate, 2)).toEqual({
      index: 2,
      message: {
        role: 'assistant',
        content: 'Filtered',
      },
      finish_reason: 'content_filter',
    });
  });
});

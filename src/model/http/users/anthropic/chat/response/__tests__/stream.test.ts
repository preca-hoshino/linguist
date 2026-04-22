/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { AnthropicChatStreamResponseAdapter } from '../stream';
import type { InternalChatStreamChunk, ModelHttpContext } from '@/types';

jest.mock('@/utils/uuid', () => ({
  v4: (): string => 'mock-uuid',
}));

jest.mock('../usage-converter', () => ({
  convertUsage: jest.fn().mockImplementation((usage: any): any => {
    if (usage === undefined || usage === null) {
      return {};
    }
    return {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens,
    };
  }),
}));

describe('AnthropicChatStreamResponseAdapter', () => {
  let adapter: AnthropicChatStreamResponseAdapter;
  const ctx: ModelHttpContext = {
    id: 'test-req-id',
    ip: '127.0.0.1',
    http: { method: 'POST', path: '/v1/messages' },
    userFormat: 'anthropic',
    requestModel: 'claude-3-5-sonnet-20240620',
    audit: {},
    timing: { start: Date.now() },
  } as unknown as ModelHttpContext;

  beforeEach(() => {
    adapter = new AnthropicChatStreamResponseAdapter();
  });

  it('should emit message_start and text block for first text chunk', () => {
    const chunk: InternalChatStreamChunk = {
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    };

    const output = adapter.formatChunk(ctx, chunk);

    // Check message_start is emitted
    expect(output).toContain('event: message_start');
    expect(output).toContain('"type":"message_start"');

    // Check content_block_start
    expect(output).toContain('event: content_block_start');
    expect(output).toContain('"type":"content_block_start"');
    expect(output).toContain('"type":"text"');

    // Check content_block_delta
    expect(output).toContain('event: content_block_delta');
    expect(output).toContain('"text":"Hello"');
  });

  it('should correctly transition from thinking to text block', () => {
    // 1. Thinking block
    const chunk1: InternalChatStreamChunk = {
      choices: [{ index: 0, delta: { reasoning_content: 'Hmm' }, finish_reason: null }],
    };
    const output1 = adapter.formatChunk(ctx, chunk1);
    expect(output1).toContain('event: message_start');
    expect(output1).toContain('"type":"thinking"');
    expect(output1).toContain('erUgSig_mock-uuid');
    expect(output1).toContain('"thinking":"Hmm"');

    // 2. Text block (triggers thinking stop and text start)
    const chunk2: InternalChatStreamChunk = {
      choices: [{ index: 0, delta: { content: 'I know' }, finish_reason: null }],
    };
    const output2 = adapter.formatChunk(ctx, chunk2);
    expect(output2).toContain('event: content_block_stop');
    expect(output2).toContain('"index":0');
    expect(output2).toContain('event: content_block_start');
    expect(output2).toContain('"index":1');
    expect(output2).toContain('"text":"I know"');
  });

  it('should correctly handle tool calls formatting', () => {
    const chunk1: InternalChatStreamChunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_weather', arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    };

    const output1 = adapter.formatChunk(ctx, chunk1);
    expect(output1).toContain('event: content_block_start');
    expect(output1).toContain('"type":"tool_use"');
    expect(output1).toContain('"name":"get_weather"');

    const chunk2: InternalChatStreamChunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"location":"Paris"}' } }],
          },
          finish_reason: null,
        },
      ],
    };

    const output2 = adapter.formatChunk(ctx, chunk2);
    expect(output2).toContain('event: content_block_delta');
    expect(output2).toContain('"type":"input_json_delta"');
    expect(output2).toContain('{\\"location\\":\\"Paris\\"}');
  });

  it('should cleanly terminate the stream with message_stop on finish_reason', () => {
    // A chunk with just stop reason
    const chunk: InternalChatStreamChunk = {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const output = adapter.formatChunk(ctx, chunk);

    // Even if no data, message_start should still be emitted
    expect(output).toContain('event: message_start');

    // Emits message delta with end_turn
    expect(output).toContain('event: message_delta');
    expect(output).toContain('"stop_reason":"end_turn"');

    // Passes usage mappings
    expect(output).toContain('"input_tokens":10');
    expect(output).toContain('"output_tokens":5');

    // Emits message_stop
    expect(output).toContain('event: message_stop');
    expect(output).toContain('"type":"message_stop"');
  });

  it('should correctly map formatEnd to null for SSE stream mode', () => {
    expect(adapter.formatEnd()).toBeNull();
  });
});

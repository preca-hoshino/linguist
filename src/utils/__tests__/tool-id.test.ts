import { normalizeToolCallIds, normalizeResponseToolCallIds, normalizeStreamChunkToolCallIds } from '../tool-id';
import type { InternalChatResponse, InternalChatStreamChunk, InternalMessage } from '@/types';

describe('normalizeToolCallIds', () => {
  it('should return the same array if no tool_calls exist', () => {
    const messages: InternalMessage[] = [{ role: 'user', content: 'hello' } as unknown as InternalMessage];
    const result = normalizeToolCallIds(messages);
    expect(result).toBe(messages); // 引用相同，无多余拷贝
  });

  it('should return the same array if messages is empty', () => {
    const result = normalizeToolCallIds([]);
    expect(result).toEqual([]);
  });

  it('should normalize assistant tool_call ids to UUID v5', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'f', arguments: '{}' } }],
      } as unknown as InternalMessage,
    ];
    const result = normalizeToolCallIds(messages);
    const normalizedId = result[0]?.tool_calls?.[0]?.id;
    expect(normalizedId).not.toBe('call_abc123');
    expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should normalize tool message tool_call_id to UUID v5', () => {
    const messages: InternalMessage[] = [
      {
        role: 'tool',
        content: 'result',
        tool_call_id: 'call_def456',
      } as unknown as InternalMessage,
    ];
    const result = normalizeToolCallIds(messages);
    const normalizedId = result[0]?.tool_call_id;
    expect(normalizedId).not.toBe('call_def456');
    expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should preserve mapping consistency between assistant and tool messages', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'g', arguments: '{}' } }],
      } as unknown as InternalMessage,
      {
        role: 'tool',
        content: 'output',
        tool_call_id: 'call_xyz',
      } as unknown as InternalMessage,
    ];
    const result = normalizeToolCallIds(messages);
    const assistantId = result[0]?.tool_calls?.[0]?.id;
    const toolId = result[1]?.tool_call_id;
    expect(assistantId).toBe(toolId);
  });

  it('should normalize standalone tool message tool_call_id', () => {
    const messages: InternalMessage[] = [
      {
        role: 'tool',
        content: 'orphan output',
        tool_call_id: 'orphan_call',
      } as unknown as InternalMessage,
    ];
    const result = normalizeToolCallIds(messages);
    // tool_call_id 会被映射到 UUID v5 即使没有对应的 assistant 消息
    const mappedId = result[0]?.tool_call_id;
    expect(mappedId).not.toBe('orphan_call');
    expect(mappedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('should not mutate original messages (immutable)', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_immutable', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      } as unknown as InternalMessage,
    ];
    const originalId = messages[0]?.tool_calls?.[0]?.id;
    normalizeToolCallIds(messages);
    // 原始消息未变动
    expect(messages[0]?.tool_calls?.[0]?.id).toBe(originalId);
  });

  it('should handle empty string tool call id', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      } as unknown as InternalMessage,
    ];
    const result = normalizeToolCallIds(messages);
    // 空字符串会回退到默认名称 'tool_call'
    expect(result[0]?.tool_calls?.[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('normalizeResponseToolCallIds', () => {
  const makeResponse = (toolCalls?: Array<{ id: string }>): InternalChatResponse =>
    ({
      choices: toolCalls
        ? [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }]
        : [{ message: { role: 'assistant', content: 'no tools' } }],
    }) as unknown as InternalChatResponse;

  it('should return the same response if no tool_calls present', () => {
    const response = makeResponse();
    const result = normalizeResponseToolCallIds(response);
    expect(result).toBe(response);
  });

  it('should return the same response if tool_calls is empty array', () => {
    const response: InternalChatResponse = {
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }],
    } as unknown as InternalChatResponse;
    const result = normalizeResponseToolCallIds(response);
    expect(result).toBe(response);
  });

  it('should normalize tool call ids in response choices', () => {
    const response = makeResponse([{ id: 'call_resp_1' }]);
    const result = normalizeResponseToolCallIds(response);
    const tcId = result.choices[0]?.message.tool_calls?.[0]?.id;
    expect(tcId).not.toBe('call_resp_1');
    expect(tcId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('normalizeStreamChunkToolCallIds', () => {
  const makeChunk = (toolCalls?: Array<{ id?: string }>): InternalChatStreamChunk =>
    ({
      choices: toolCalls ? [{ delta: { tool_calls: toolCalls }, index: 0 }] : [{ delta: {}, index: 0 }],
    }) as unknown as InternalChatStreamChunk;

  it('should return the same chunk if no tool_calls present', () => {
    const chunk = makeChunk();
    const result = normalizeStreamChunkToolCallIds(chunk);
    expect(result).toBe(chunk);
  });

  it('should normalize defined tool call ids in stream chunk', () => {
    const chunk = makeChunk([{ id: 'call_stream_1' }]);
    const result = normalizeStreamChunkToolCallIds(chunk);
    const tcId = result.choices[0]?.delta.tool_calls?.[0]?.id;
    expect(tcId).not.toBe('call_stream_1');
    expect(tcId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('should leave undefined tool call id as undefined', () => {
    const chunk = makeChunk([{ id: undefined as unknown as string }]);
    const result = normalizeStreamChunkToolCallIds(chunk);
    expect(result.choices[0]?.delta.tool_calls?.[0]?.id).toBeUndefined();
  });
});

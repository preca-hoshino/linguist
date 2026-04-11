import { convertToMessages } from '../message-converter';
import type { GeminiContent, GeminiSystemInstruction } from '../types';

describe('Gemini Request Message Converter', () => {
  it('应该正确转换 system instruction 为 role: system 消息', () => {
    const system: GeminiSystemInstruction = {
      parts: [{ text: 'You are an AI assistant.' }, { text: 'Respond gracefully.' }],
      role: 'system',
    };
    const messages = convertToMessages([], system);
    expect(messages).toEqual([{ role: 'system', content: 'You are an AI assistant.\n\nRespond gracefully.' }]);
  });

  it('应该转换普通的文本内容', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('应该提取 inlineData 和 fileData 为 MediaContentPart', () => {
    const contents: GeminiContent[] = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'base64str' } },
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/file.pdf' } },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', mime_type: 'image/png', base64_data: 'base64str' },
          { type: 'file', mime_type: 'application/pdf', url: 'https://example.com/file.pdf' },
        ],
      },
    ]);
  });

  it('应该处理 functionCall 并转换成 tool_calls', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'getWeather',
              args: { city: 'London' },
              id: 'call_123',
            },
          },
        ],
      },
      {
        role: 'user', // user 返回 tool response
        parts: [
          {
            functionResponse: {
              name: 'getWeather',
              response: { content: '20 degrees' },
              id: 'call_123',
            },
          },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'getWeather',
              arguments: '{"city":"London"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '20 degrees',
        name: 'getWeather',
        tool_call_id: 'call_123',
      },
    ]);
  });

  it('应该清理孤立的 tool_calls (removeOrphanedToolCalls)', () => {
    // 只有 model functionCall，但上下文中没有匹配的 functionResponse
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'getWeather',
              args: { city: 'London' },
              id: 'call_orphan',
            },
          },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    // 因为会被 removeOrphanedToolCalls 清除所有孤立调用，只剩下 content="" (也会被过滤)
    expect(messages).toEqual([]);
  });

  it('如果单一 content 中既有 functionCall 也有 functionResponse，应拆开', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'search', args: { q: 'AI' }, id: 'call_same' } },
          { functionResponse: { name: 'search', response: 'AI is cool', id: 'call_same' } },
          { text: 'I found something about AI.' },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_same',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"q":"AI"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'AI is cool',
        name: 'search',
        tool_call_id: 'call_same',
      },
      {
        role: 'assistant',
        content: 'I found something about AI.',
      },
    ]);
  });

  it('如果在解析复杂的 functionResponse.response 时含有 content/type==text，应该正确提取', () => {
    const mcpResponseString = JSON.stringify({
      content: [{ type: 'text', text: 'Real content from MCP' }],
      isError: false,
    });

    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'mcpTool', args: {}, id: 'mcp_1' } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'mcpTool',
              response: {
                content: mcpResponseString,
              },
              id: 'mcp_1',
            },
          },
        ],
      },
    ];

    const messages = convertToMessages(contents);
    expect(messages[1]).toEqual({
      role: 'tool',
      content: 'Real content from MCP',
      name: 'mcpTool',
      tool_call_id: 'mcp_1',
    });
  });

  it('应该处理 functionResponse 内容提取的回退情况（null, 无content字段对象）', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 't1', args: {}, id: 'id1' } },
          { functionCall: { name: 't2', args: {}, id: 'id2' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 't1', response: null, id: 'id1' } },
          { functionResponse: { name: 't2', response: { other: '123' }, id: 'id2' } },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages[1]).toEqual({ role: 'tool', content: 'null', name: 't1', tool_call_id: 'id1' });
    expect(messages[2]).toEqual({ role: 'tool', content: '{"other":"123"}', name: 't2', tool_call_id: 'id2' });
  });

  it('应该合并同一个名称的多个 functionResponse', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {}, id: 'id1' } }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'search', response: 'part1', id: 'id1' } },
          { functionResponse: { name: 'search', response: 'part2', id: 'id2' } },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages[1]).toEqual({ role: 'tool', content: 'part1\n\npart2', name: 'search', tool_call_id: 'id1' });
  });

  it('应该处理 user 角色同时提供 functionResponse 和普通文本', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'search', args: {}, id: 'id1' } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'search', response: 'done', id: 'id1' } }, { text: 'Also note this' }],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages[1]).toEqual({ role: 'tool', content: 'done', name: 'search', tool_call_id: 'id1' });
    expect(messages[2]).toEqual({ role: 'user', content: 'Also note this' });
  });

  it('如果 assistant 包含废弃的 tool_calls 但有文本，则保留文本', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'orphan', args: {}, id: 'orphan_id' } }, { text: 'I tried calling a tool.' }],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([{ role: 'assistant', content: 'I tried calling a tool.' }]);
  });

  it('如果 tool 消息没有对应的 tool_calls，应该被清理掉', () => {
    const contents: GeminiContent[] = [
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'fake', response: 'fake response', id: 'fake_id' } }],
      },
    ];
    const messages = convertToMessages(contents);
    expect(messages).toEqual([]);
  });

  it('应该处理 functionResponse/functionCall 没有 id 时降级使用 name 的情况', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'no_id_tool', args: {} } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'no_id_tool', response: 'done' } }],
      },
    ];
    const messages = convertToMessages(contents);
    // biome-ignore lint/style/noNonNullAssertion: valid
    expect(messages[0]!.tool_calls?.[0]?.id).toBe('no_id_tool');
    expect(messages[1]).toEqual({ role: 'tool', content: 'done', name: 'no_id_tool', tool_call_id: 'no_id_tool' });
  });

  it('应该处理 systemInstruction 没有有效文本的情况', () => {
    const system: GeminiSystemInstruction = {
      role: 'system',
      parts: [
        { text: '' },
        { text: undefined as unknown as string }, // hit the ?? '' branch
      ],
    };
    const messages = convertToMessages([], system);
    expect(messages).toEqual([]);
  });

  it('应该处理 parse MCP 返回格式失败或者无文本返回时的 fallback 回退逻辑', () => {
    const responseWithArrayContent = JSON.stringify({ content: [{ type: 'other', foo: 'bar' }] });
    const responseNotArray = JSON.stringify({ content: 'string inside' });

    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'mcp1', args: {}, id: '1' } }] },
      { role: 'model', parts: [{ functionCall: { name: 'mcp2', args: {}, id: '2' } }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'mcp1', response: { content: responseWithArrayContent }, id: '1' } },
          { functionResponse: { name: 'mcp2', response: { content: responseNotArray }, id: '2' } },
        ],
      },
    ];

    // They fallback to returning the literal object/string of 'content'
    const messages = convertToMessages(contents);
    // biome-ignore lint/style/noNonNullAssertion: valid
    expect(messages[2]!.content).toBe(responseWithArrayContent);
    // biome-ignore lint/style/noNonNullAssertion: valid
    expect(messages[3]!.content).toBe(responseNotArray);
  });

  it('应该跳过 parts 为空，或其中不包含任何相关数据的无用消息', () => {
    const contents: GeminiContent[] = [
      { role: 'user', parts: [] },
      { role: 'model', parts: [{ text: '' }] }, // Empty string is ignored
      { role: 'user', parts: [{ executableCode: { code: 'test' } } as unknown as { text?: string }] }, // unsupported parts
    ];
    // They should produce empty outcomes or empty content
    const messages = convertToMessages(contents);
    // User part is empty, model part yields empty string, Unsupported part yields nothing
    expect(messages).toEqual([{ role: 'assistant', content: '' }]);
  });

  it('多重组合覆盖(同时存在 functionCall, functionResponse 但是且没有 content)以触发 hasContent=false 分支', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'act', args: {}, id: 'id_act' } },
          { functionResponse: { name: 'act', response: 'ok', id: 'id_act' } },
        ],
      },
    ];
    const messages = convertToMessages(contents);
    // Due to hasContent=false, only tool_calls and tool messages are populated
    expect(messages.length).toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: valid
    expect(messages[0]!.tool_calls).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: valid
    expect(messages[1]!.role).toBe('tool');
  });
});

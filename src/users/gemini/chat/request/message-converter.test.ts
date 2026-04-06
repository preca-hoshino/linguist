import { convertToMessages } from './message-converter';
import type { GeminiContent, GeminiSystemInstruction } from './types';

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
});

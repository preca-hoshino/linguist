import { convertMessages, convertSystemPrompt } from '../message-converter';
import type { AnthropicMessage, AnthropicTextContentBlock } from '../types';

describe('Anthropic Request Message Converter', () => {
  describe('convertSystemPrompt', () => {
    it('应该处理 undefined', () => {
      expect(convertSystemPrompt()).toBeUndefined();
    });

    it('应该处理 string 类型的 system prompt', () => {
      expect(convertSystemPrompt('You are a helpful assistant.')).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
    });

    it('应该处理 array 类型的 system prompt', () => {
      const blocks: AnthropicTextContentBlock[] = [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Always be polite.' },
      ];
      expect(convertSystemPrompt(blocks)).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.\nAlways be polite.',
      });
    });
  });

  describe('convertMessages', () => {
    it('应该转换纯文本的 user 和 assistant 消息', () => {
      const messages: AnthropicMessage[] = [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      expect(convertMessages(messages)).toEqual([
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
      ]);
    });

    it('应该处理包含普通 content blocks 的 user 消息', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', mime_type: 'image/png', base64_data: 'base64data' },
          ],
        },
      ]);
    });

    it('应该处理包含远程 url 图片的 user 消息', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/image.jpg' },
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'user',
          content: [{ type: 'image', url: 'https://example.com/image.jpg' }],
        },
      ]);
    });

    it('应该提取 tool_result 并拆解为独立的 tool 消息', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-id-1',
              content: 'It is 70 degrees.',
            },
            { type: 'text', text: 'Thanks!' },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'tool',
          content: 'It is 70 degrees.',
          tool_call_id: 'tool-id-1',
        },
        {
          role: 'user',
          content: 'Thanks!',
        },
      ]);
    });

    it('应该正确处理发生错误的 tool_result', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-id-err',
              content: 'Failed to execute tool.',
              is_error: true,
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'tool',
          content: '[Error]\nFailed to execute tool.',
          tool_call_id: 'tool-id-err',
        },
      ]);
    });

    it('应该处理拥有复杂 content block (tool_use, thinking, text) 的 assistant 消息', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I need to check the weather.', signature: 'sig1' },
            { type: 'text', text: 'Let me look that up for you.' },
            {
              type: 'tool_use',
              id: 'tool-use-id-1',
              name: 'get_weather',
              input: { location: 'SF' },
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'assistant',
          content: 'Let me look that up for you.',
          reasoning_content: 'I need to check the weather.',
          tool_calls: [
            {
              id: 'tool-use-id-1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"SF"}',
              },
            },
          ],
        },
      ]);
    });
  });
});

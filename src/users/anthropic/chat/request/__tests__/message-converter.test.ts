import { convertMessages, convertSystemPrompt } from '../message-converter';
import type { AnthropicMessage, AnthropicTextContentBlock, AnthropicContentBlock } from '../types';

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

    it('应该处理 image block 中 media_type 缺失的情况，使用默认 image/jpeg', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', data: 'data' } as unknown as {
                type: 'base64';
                data: string;
                media_type: string;
              }, // 故意缺失 media_type
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'user',
          content: [{ type: 'image', mime_type: 'image/jpeg', base64_data: 'data' }],
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

    it('应该跳过普通 user 消息中混入的 tool_use 和 thinking 块', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'anomalous', name: 'hack', input: {} },
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          ],
        },
      ];
      // tool_use and thinking should be dropped by convertContentBlocks
      expect(convertMessages(messages)).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('应该跳过不可识别块或无效参数块（如无效的 base64/url data），当 normalBlocks 完全被忽略时不再推送空 user 消息', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'unknown_type', data: 'junk' } as unknown as AnthropicContentBlock,
            { type: 'image', source: { type: 'base64', data: '' } }, // 无效空数据
            { type: 'image', source: { type: 'url', url: '' } as unknown as { type: 'url'; url: string } }, // 无效空 URL
            {
              type: 'image',
              source: { type: 'other' } as unknown as { type: 'base64'; data: string; media_type: string },
            }, // 完全无效源
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([]);
    });

    it('应该处理不带 text 的 assistant 消息， content 回退为空字符串', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-use-only',
              name: 'get_weather',
              input: {},
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tool-use-only',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{}',
              },
            },
          ],
        },
      ]);
    });

    it('应该处理不带 thinking 的 assistant block 格式', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Assistant block without thinking' }],
        },
      ];
      expect(convertMessages(messages)).toEqual([{ role: 'assistant', content: 'Assistant block without thinking' }]);
    });

    it('应该处理 tool_result 中 content 为 undefined 的情况', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-id-undef',
              content: undefined as unknown as AnthropicTextContentBlock[],
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([{ role: 'tool', content: '', tool_call_id: 'tool-id-undef' }]);
    });

    it('应该处理 tool_result 中 content 为多数组的情况', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            // 单一 text 块，降级为字符串
            {
              type: 'tool_result',
              tool_use_id: 'id-1',
              content: [{ type: 'text', text: 'Single text in array' }],
            },
            // 多个 text 块，拼接为字符串
            {
              type: 'tool_result',
              tool_use_id: 'id-2',
              content: [
                { type: 'text', text: 'Text 1' },
                { type: 'text', text: 'Text 2' },
              ],
            },
            // 混合块，保留为 ContentPart 数组格式
            {
              type: 'tool_result',
              tool_use_id: 'id-3',
              content: [
                { type: 'text', text: 'Mixed' },
                { type: 'image', source: { type: 'url', url: 'https://img.com' } },
              ],
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([
        { role: 'tool', content: 'Single text in array', tool_call_id: 'id-1' },
        { role: 'tool', content: 'Text 1\nText 2', tool_call_id: 'id-2' },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Mixed' },
            { type: 'image', url: 'https://img.com' },
          ],
          tool_call_id: 'id-3',
        },
      ]);
    });

    it('应该处理 tool_result 中 content 为未预料类型（如数字）的回退情况', () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-id-num',
              content: 12345 as unknown as string, // anomalous type for coverage
            },
          ],
        },
      ];
      expect(convertMessages(messages)).toEqual([{ role: 'tool', content: '12345', tool_call_id: 'tool-id-num' }]);
    });
  });
});

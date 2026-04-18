import { convertMessages } from '../message-converter';
import type { OpenAICompatChatMessage } from '../types';

describe('OpenAICompat Message Converter', () => {
  it('应该正常转换只含有纯文本的情况', () => {
    const messages: OpenAICompatChatMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(convertMessages(messages)).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('应该推断 data URL image 对应的 mime_type 并去掉类型强保留', () => {
    const messages: OpenAICompatChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this:' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo' },
          },
        ],
      },
    ];
    expect(convertMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this:' },
          { type: 'image', mime_type: 'image/png', base64_data: 'iVBORw0KGgo' },
        ],
      },
    ]);
  });

  it('如果 url 不是 data url，则转为普通的远程图片', () => {
    const messages: OpenAICompatChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.jpg' },
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

  it('应该原样保留其他属性 (name, tool_calls, tool_call_id, reasoning_content)', () => {
    const messages: OpenAICompatChatMessage[] = [
      {
        role: 'assistant',
        content: 'I have the weather.',
        name: 'WeatherBot',
        reasoning_content: 'Thought process',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'getWeather', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'Sunny',
        tool_call_id: 'call_1',
      },
    ];
    expect(convertMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: 'I have the weather.',
        name: 'WeatherBot',
        reasoning_content: 'Thought process',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'getWeather', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'Sunny',
        tool_call_id: 'call_1',
      },
    ]);
  });

  it('应该过滤掉 content 为 null 的情况并设为空字符串', () => {
    const messages: OpenAICompatChatMessage[] = [{ role: 'assistant', content: null }];
    expect(convertMessages(messages)).toEqual([{ role: 'assistant', content: '' }]);
  });
});

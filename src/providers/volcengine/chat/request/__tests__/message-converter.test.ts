import type { InternalMessage } from '@/types';
import { convertMessages } from '../message-converter';

describe('VolcEngine Request Message Converter', () => {
  it('应该保留字符串 content 和基础属性', () => {
    const messages: InternalMessage[] = [{ role: 'user', content: 'Hi', name: 'Al' }];
    expect(convertMessages(messages)).toEqual([{ role: 'user', content: 'Hi', name: 'Al' }]);
  });

  it('应该保留 tool_calls, tool_call_id 和 reasoning_content', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: 'Sure',
        reasoning_content: 'abc',
        tool_calls: [{ id: 'tc', type: 'function', function: { name: 'v', arguments: '{}' } }],
      },
      { role: 'tool', content: 'res', tool_call_id: 'tc' },
    ];
    expect(convertMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: 'Sure',
        reasoning_content: 'abc',
        tool_calls: [{ id: 'tc', type: 'function', function: { name: 'v', arguments: '{}' } }],
      },
      { role: 'tool', content: 'res', tool_call_id: 'tc' },
    ]);
  });

  it('如果没有媒体内容，则压缩 content 块为纯文本字符串', () => {
    const messages: InternalMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First line.' },
          { type: 'audio', url: 'skip.wav' }, // 被跳过
          { type: 'text', text: 'Second line.' },
        ],
      },
    ];
    expect(convertMessages(messages)).toEqual([{ role: 'user', content: 'First line.\nSecond line.' }]);
  });

  it('如果有支持的 image，应输出 content object array 并自动处理 mimeType', () => {
    const messages: InternalMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'IMG:' },
          { type: 'image', url: 'a.png' },
          { type: 'image', base64_data: 'b64d', mime_type: 'image/jpeg' },
          { type: 'image', base64_data: 'b64z' }, // 推断 mime_type: image/jpeg
        ],
      },
    ];
    expect(convertMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'IMG:' },
          { type: 'image_url', image_url: { url: 'a.png' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64d' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64z' } },
        ],
      },
    ]);
  });
});

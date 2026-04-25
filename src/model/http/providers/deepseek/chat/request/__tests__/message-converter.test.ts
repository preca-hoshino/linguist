import type { InternalMessage } from '@/types';
import { normalizeMessages } from '../message-converter';

describe('DeepSeek Request Message Converter', () => {
  describe('normalizeMessages', () => {
    it('应该原样转换 string content，保留常用属性', () => {
      const messages: InternalMessage[] = [{ role: 'user', content: 'Hello', name: 'User1' }];
      expect(normalizeMessages(messages)).toEqual([{ role: 'user', content: 'Hello', name: 'User1' }]);
    });

    it('assistant 消息携带 reasoning_content 时应保留并传递', () => {
      const messages: InternalMessage[] = [
        {
          role: 'assistant',
          content: 'OK',
          reasoning_content: 'thinking...',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ];
      const result = normalizeMessages(messages);
      expect(result).toEqual([
        {
          role: 'assistant',
          content: 'OK',
          reasoning_content: 'thinking...',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ]);
    });

    it('assistant 消息不携带 reasoning_content 时不应注入默认值', () => {
      const messages: InternalMessage[] = [{ role: 'assistant', content: 'Result' }];
      const result = normalizeMessages(messages);
      expect(result).toEqual([{ role: 'assistant', content: 'Result' }]);
      expect(result[0]).not.toHaveProperty('reasoning_content');
    });

    it('assistant 消息携带空字符串 reasoning_content 时应保留（由数据决定）', () => {
      const messages: InternalMessage[] = [{ role: 'assistant', content: 'Result', reasoning_content: '' }];
      const result = normalizeMessages(messages);
      expect(result[0]).toHaveProperty('reasoning_content', '');
    });

    it('非 assistant 消息不应包含 reasoning_content', () => {
      const messages: InternalMessage[] = [{ role: 'user', content: 'Hello' }];
      const result = normalizeMessages(messages);
      expect(result[0]).not.toHaveProperty('reasoning_content');
    });

    it('应该将 image 转换为 image_url，并忽略不支持的内容', () => {
      const messages: InternalMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look:' },
            { type: 'image', url: 'https://ex.com/img.jpg' },
            { type: 'image', base64_data: 'b64d', mime_type: 'image/jpeg' },
            { type: 'audio', url: 'no' }, // skipped
            { type: 'image' }, // skipped, no base64/url
          ],
        },
      ];
      expect(normalizeMessages(messages)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look:' },
            { type: 'image_url', image_url: { url: 'https://ex.com/img.jpg' } },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64d' } },
          ],
        },
      ]);
    });
  });
});

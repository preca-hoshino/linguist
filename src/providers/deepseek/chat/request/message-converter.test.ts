import type { InternalMessage } from '@/types';
import { normalizeMessages, prepareMessagesForReasoner } from './message-converter';

describe('DeepSeek Request Message Converter', () => {
  describe('normalizeMessages', () => {
    it('应该原样转换 string content，保留常用属性', () => {
      const messages: InternalMessage[] = [{ role: 'user', content: 'Hello', name: 'User1' }];
      expect(normalizeMessages(messages)).toEqual([{ role: 'user', content: 'Hello', name: 'User1' }]);
    });

    it('应该移除 reasoning_content 和多余属性', () => {
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
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ]);
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

  describe('prepareMessagesForReasoner', () => {
    it('对于 assistant，如果没有 reasoning_content 应该加上空的 reasoning_content', () => {
      const messages: InternalMessage[] = [{ role: 'assistant', content: 'Result' }];
      expect(prepareMessagesForReasoner(messages)).toEqual([
        { role: 'assistant', content: 'Result', reasoning_content: '' },
      ]);
    });

    it('如果含有 reasoning_content，应保留', () => {
      const messages: InternalMessage[] = [{ role: 'assistant', content: 'Result', reasoning_content: 'Thought' }];
      expect(prepareMessagesForReasoner(messages)).toEqual([
        { role: 'assistant', content: 'Result', reasoning_content: 'Thought' },
      ]);
    });

    it('对于非 assistant 消息，应移除 reasoning_content', () => {
      const messages: InternalMessage[] = [
        { role: 'user', content: 'Hello', reasoning_content: 'Not allowed' } as unknown as InternalMessage,
      ];
      expect(prepareMessagesForReasoner(messages)).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('处理 multi-modal', () => {
      const messages: InternalMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check' },
            { type: 'image', url: 'foo.jpg' },
          ],
        },
      ];
      expect(prepareMessagesForReasoner(messages)).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check' },
            { type: 'image_url', image_url: { url: 'foo.jpg' } },
          ],
        },
      ]);
    });
  });
});

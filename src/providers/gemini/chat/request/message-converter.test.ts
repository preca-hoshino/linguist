import type { InternalMessage } from '@/types';
import { convertMessages } from './message-converter';

describe('Gemini Provider Request Message Converter', () => {
  it('应该将 system 消息抽取为 systemInstruction', () => {
    const messages: InternalMessage[] = [
      { role: 'system', content: 'You are Gemini.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = convertMessages(messages);
    expect(result.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are Gemini.' }],
    });
    expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  it('应该合并多个 system 消息', () => {
    const messages: InternalMessage[] = [
      { role: 'system', content: 'You are an AI.' },
      { role: 'system', content: 'Be nice.' },
    ];
    const { systemInstruction } = convertMessages(messages);
    expect(systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are an AI.\n\nBe nice.' }],
    });
  });

  it('应该处理多模态内容并转换为 inlineData/fileData', () => {
    const messages: InternalMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look:' },
          { type: 'image', base64_data: 'b64d', mime_type: 'image/png' },
          { type: 'file', url: 'gs://bucket/file.pdf' },
          { type: 'audio', base64_data: '123' }, // default audio/mp4
        ],
      },
    ];
    const { contents } = convertMessages(messages);
    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Look:' },
          { inlineData: { mimeType: 'image/png', data: 'b64d' } },
          { fileData: { mimeType: 'application/octet-stream', fileUri: 'gs://bucket/file.pdf' } },
          { inlineData: { mimeType: 'audio/mp4', data: '123' } },
        ],
      },
    ]);
  });

  it('应该将 assistant 角色映射为 model，并处理 tool_calls', () => {
    const messages: InternalMessage[] = [
      {
        role: 'assistant',
        content: 'I need to check.',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{"q": "xx"}' } }],
      },
    ];
    const { contents } = convertMessages(messages);
    expect(contents).toEqual([
      {
        role: 'model',
        parts: [{ text: 'I need to check.' }, { functionCall: { name: 'f', args: { q: 'xx' } } }],
      },
    ]);
  });

  it('应该将 tool 角色转为 user + functionResponse', () => {
    const messages: InternalMessage[] = [
      {
        role: 'tool',
        content: '{"result":"ok"}',
        name: 'f',
        tool_call_id: '1',
      },
    ];
    const { contents } = convertMessages(messages);
    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'f',
              response: { result: 'ok' },
            },
          },
        ],
      },
    ]);
  });
});

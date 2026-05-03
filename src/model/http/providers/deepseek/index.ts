// src/providers/deepseek/index.ts — DeepSeek 插件级入口

import type { ProviderPlugin } from '@/model/http/providers/types';
import { DeepSeekChatClient } from './chat/client';
import { DeepSeekChatRequestAdapter } from './chat/request';
import { DeepSeekChatResponseAdapter } from './chat/response';
import { DeepSeekChatStreamResponseAdapter } from './chat/response/stream';
import { mapDeepSeekError } from './error-mapping';

export const deepseekPlugin: ProviderPlugin = {
  kind: 'deepseek',
  supportedModelTypes: ['chat'],
  supportedChatParameters: [
    'temperature',
    'top_p',
    'max_tokens',
    'frequency_penalty',
    'presence_penalty',
    'stop',
  ] as const,

  getChatAdapterSet: (config) => ({
    requestAdapter: new DeepSeekChatRequestAdapter(),
    responseAdapter: new DeepSeekChatResponseAdapter(),
    streamResponseAdapter: new DeepSeekChatStreamResponseAdapter(),
    client: new DeepSeekChatClient(config),
  }),

  mapError: (status, body) => mapDeepSeekError(status, body),
};

// src/providers/mimo/index.ts — MiMo 插件级入口

import type { ProviderPlugin } from '@/model/http/providers/types';
import { MiMoChatClient } from './chat/client';
import { MiMoChatRequestAdapter } from './chat/request';
import { MiMoChatResponseAdapter } from './chat/response';
import { MiMoChatStreamResponseAdapter } from './chat/response/stream';
import { mapMimoError } from './error-mapping';

export const mimoPlugin: ProviderPlugin = {
  kind: 'mimo',

  // MiMo 初期仅支持 Chat 模型（TTS 后续扩展）
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
    requestAdapter: new MiMoChatRequestAdapter(),
    responseAdapter: new MiMoChatResponseAdapter(),
    streamResponseAdapter: new MiMoChatStreamResponseAdapter(),
    client: new MiMoChatClient(config),
  }),

  mapError: (status, body) => mapMimoError(status, body),
};

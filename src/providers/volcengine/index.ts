// src/providers/volcengine/index.ts — VolcEngine 插件级入口

import type { ProviderPlugin } from '@/providers/types';
import { VolcEngineChatClient } from './chat/client';
import { VolcEngineChatRequestAdapter } from './chat/request';
import { VolcEngineChatResponseAdapter } from './chat/response';
import { VolcEngineChatStreamResponseAdapter } from './chat/response/stream';
import { VolcEngineEmbeddingClient } from './embedding/client';
import { VolcEngineEmbeddingRequestAdapter } from './embedding/request';
import { VolcEngineEmbeddingResponseAdapter } from './embedding/response';

import { mapVolcEngineError } from './error-mapping';

export const volcenginePlugin: ProviderPlugin = {
  kind: 'volcengine',

  getChatAdapterSet: (config) => ({
    requestAdapter: new VolcEngineChatRequestAdapter(),
    responseAdapter: new VolcEngineChatResponseAdapter(),
    streamResponseAdapter: new VolcEngineChatStreamResponseAdapter(),
    client: new VolcEngineChatClient(config.apiKey, config.baseUrl),
  }),

  getEmbeddingAdapterSet: (config) => ({
    requestAdapter: new VolcEngineEmbeddingRequestAdapter(),
    responseAdapter: new VolcEngineEmbeddingResponseAdapter(),
    client: new VolcEngineEmbeddingClient(config.apiKey, config.baseUrl),
  }),

  mapError: (status, body) => mapVolcEngineError(status, body),
};

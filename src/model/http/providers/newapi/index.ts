// src/model/http/providers/newapi/index.ts — New API 插件级入口

import type { ProviderPlugin } from '@/model/http/providers/types';
import { NewApiChatClient } from './chat/client';
import { NewApiChatRequestAdapter } from './chat/request';
import { NewApiChatResponseAdapter } from './chat/response';
import { NewApiChatStreamResponseAdapter } from './chat/response/stream';
import { NewApiEmbeddingClient } from './embedding/client';
import { NewApiEmbeddingRequestAdapter } from './embedding/request';
import { NewApiEmbeddingResponseAdapter } from './embedding/response';
import { mapNewApiError } from './error-mapping';

export const newapiPlugin: ProviderPlugin = {
  kind: 'newapi',
  supportedModelTypes: ['chat', 'embedding'],
  supportedChatParameters: [
    'temperature',
    'top_p',
    'max_tokens',
    'frequency_penalty',
    'presence_penalty',
    'stop',
  ] as const,
  supportedEmbeddingParameters: ['dimensions', 'encoding_format'] as const,

  getChatAdapterSet: (config) => ({
    requestAdapter: new NewApiChatRequestAdapter(),
    responseAdapter: new NewApiChatResponseAdapter(),
    streamResponseAdapter: new NewApiChatStreamResponseAdapter(),
    client: new NewApiChatClient(config),
  }),

  getEmbeddingAdapterSet: (config) => ({
    requestAdapter: new NewApiEmbeddingRequestAdapter(),
    responseAdapter: new NewApiEmbeddingResponseAdapter(),
    client: new NewApiEmbeddingClient(config),
  }),

  mapError: (status, body) => mapNewApiError(status, body),
};

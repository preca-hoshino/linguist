// src/providers/gemini/index.ts — Gemini 插件级入口

import type { ProviderPlugin } from '@/model/http/providers/types';
import { GeminiChatClient } from './chat/client';
import { GeminiChatRequestAdapter } from './chat/request';
import { GeminiChatResponseAdapter } from './chat/response';
import { GeminiChatStreamResponseAdapter } from './chat/response/stream';
import { GeminiEmbeddingClient } from './embedding/client';
import { GeminiEmbeddingRequestAdapter } from './embedding/request';
import { GeminiEmbeddingResponseAdapter } from './embedding/response';

import { mapGeminiError } from './error-mapping';

export const geminiPlugin: ProviderPlugin = {
  kind: 'gemini',

  getChatAdapterSet: (config) => ({
    requestAdapter: new GeminiChatRequestAdapter(),
    responseAdapter: new GeminiChatResponseAdapter(),
    streamResponseAdapter: new GeminiChatStreamResponseAdapter(),
    client: new GeminiChatClient(config.apiKey, config.baseUrl),
  }),

  getEmbeddingAdapterSet: (config) => ({
    requestAdapter: new GeminiEmbeddingRequestAdapter(),
    responseAdapter: new GeminiEmbeddingResponseAdapter(),
    client: new GeminiEmbeddingClient(config.apiKey, config.baseUrl),
  }),

  mapError: (status, body) => mapGeminiError(status, body),
};

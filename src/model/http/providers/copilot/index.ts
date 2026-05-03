// src/providers/copilot/index.ts — Copilot 提供商插件入口

import type { ProviderPlugin } from '@/model/http/providers/types';
import { CopilotChatClient } from './chat/client';
import { CopilotChatRequestAdapter } from './chat/request';
import { CopilotChatResponseAdapter } from './chat/response';
import { CopilotChatStreamResponseAdapter } from './chat/response/stream';
import { CopilotEmbeddingClient } from './embedding/client';
import { CopilotEmbeddingRequestAdapter } from './embedding/request';
import { CopilotEmbeddingResponseAdapter } from './embedding/response';
import { mapCopilotError } from './error-mapping';

export const copilotPlugin: ProviderPlugin = {
  kind: 'copilot',
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
    requestAdapter: new CopilotChatRequestAdapter(),
    responseAdapter: new CopilotChatResponseAdapter(),
    streamResponseAdapter: new CopilotChatStreamResponseAdapter(),
    // 传入完整 config，因为 client 需要通过 credential.accessToken 动态获取 Token
    client: new CopilotChatClient(config),
  }),
  getEmbeddingAdapterSet: (config) => ({
    requestAdapter: new CopilotEmbeddingRequestAdapter(),
    responseAdapter: new CopilotEmbeddingResponseAdapter(),
    client: new CopilotEmbeddingClient(config),
  }),
  mapError: (status, body) => mapCopilotError(status, body),
};

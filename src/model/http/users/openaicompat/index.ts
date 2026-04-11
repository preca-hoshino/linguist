// src/users/openaicompat/index.ts — 导出所有 OpenAICompat 用户适配器

export { OpenAICompatChatRequestAdapter } from './chat/request';
export { OpenAICompatChatResponseAdapter } from './chat/response';
export { OpenAICompatChatStreamResponseAdapter } from './chat/response/stream';

export { OpenAICompatEmbeddingRequestAdapter } from './embedding/request';
export { OpenAICompatEmbeddingResponseAdapter } from './embedding/response';

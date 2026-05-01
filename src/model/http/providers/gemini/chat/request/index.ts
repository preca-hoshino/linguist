// src/providers/chat/gemini/request/index.ts — Gemini 请求适配器（精简编排层）

import type { ProviderChatRequestAdapter } from '@/model/http/providers/types';
import type { InternalChatRequest } from '@/types';
import { createLogger, logColors } from '@/utils';
import { buildGenerationConfig, buildThinkingConfig } from './config-builder';
import { convertMessages } from './message-converter';
import { convertToolChoice, convertTools } from './tool-converter';

const logger = createLogger('Provider:Gemini', logColors.bold + logColors.yellow);

/**
 * Gemini 聊天请求适配器
 * InternalChatRequest + routedModel → Gemini generateContent 请求体
 *
 * 核心转换逻辑：
 * - messages → contents[] (role 映射: assistant→model, system 提取到 systemInstruction)
 * - temperature/top_p/max_tokens → generationConfig 嵌套
 * - tools → Gemini functionDeclarations 格式
 * - tool_choice → toolConfig.functionCallingConfig
 * - thinking → thinkingConfig
 * - 多模态内容 (image/audio/video) → inlineData parts
 * - tool 消息 → functionResponse parts
 * - assistant tool_calls → functionCall parts
 */
export class GeminiChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(
    internalReq: InternalChatRequest,
    routedModel: string,
    _modelConfig?: Record<string, unknown>,
  ): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
      },
      'Adapting internal request to Gemini format',
    );

    const req: Record<string, unknown> = {};

    // 1) 提取 system 消息 → systemInstruction，其余 → contents
    const { systemInstruction, contents } = convertMessages(internalReq.messages);
    if (systemInstruction) {
      req.systemInstruction = systemInstruction;
    }
    req.contents = contents;

    // 2) generationConfig
    const genConfig = buildGenerationConfig(internalReq);
    if (Object.keys(genConfig).length > 0) {
      req.generationConfig = genConfig;
    }

    // 3) tools（函数声明）
    if (internalReq.tools && internalReq.tools.length > 0) {
      req.tools = convertTools(internalReq.tools);
    }

    // 4) toolConfig（工具选择策略）
    if (internalReq.tool_choice !== undefined) {
      req.toolConfig = convertToolChoice(internalReq.tool_choice);
    }

    // 5) thinkingConfig
    // type='disabled' 时不发送 thinkingConfig：
    //   - 不支持 thinkingConfig 的模型默认不思考，无需显式关闭
    //   - 支持 thinkingConfig 的模型省略该字段时使用自身默认行为
    // 这样避免因模型不支持 thinkingConfig 字段而返回 400 错误
    if (internalReq.thinking && internalReq.thinking.type !== 'disabled') {
      req.thinkingConfig = buildThinkingConfig(internalReq.thinking);
    }

    return req;
  }
}

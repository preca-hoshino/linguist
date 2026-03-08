// src/users/chat/gemini/request/index.ts — Gemini 请求适配器（精简编排层）

import type { UserChatRequestAdapter } from '../../interface';
import type { InternalChatRequest } from '../../../../types';
import type { GeminiChatRequestBody } from './types';
import { convertToMessages } from './message-converter';
import { convertTools, convertToolConfig } from './tool-converter';
import { convertThinkingConfig } from './thinking-converter';
import { GatewayError, createLogger, logColors } from '../../../../utils';

const logger = createLogger('User:Gemini', logColors.bold + logColors.blue);

/**
 * Gemini 原生格式聊天请求 → InternalChatRequest
 *
 * 核心转换逻辑：
 * - systemInstruction → role='system' 消息（插入 messages 开头）
 * - contents[role='user'] → role='user' 消息
 * - contents[role='model'] → role='assistant' 消息
 * - contents 中包含 functionCall 的 model → assistant + tool_calls
 * - contents 中包含 functionResponse 的 user → role='tool' 消息
 * - generationConfig → 展开为扁平的生成控制参数
 * - tools[].functionDeclarations → ToolDefinition[]
 * - toolConfig → tool_choice
 * - thinkingConfig → thinking
 * - inlineData → MediaContentPart (base64)
 *
 * 注意：不包含 model 字段，model 由核心流程从 URL 路径提取写入 GatewayContext.requestModel
 */
export class GeminiChatRequestAdapter implements UserChatRequestAdapter {
  public toInternal(userReq: unknown): InternalChatRequest {
    const body = userReq as GeminiChatRequestBody;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof body !== 'object' || body === null || !Array.isArray(body.contents) || body.contents.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Gemini chat request must include a non-empty contents array');
    }

    // 参数范围校验（在适配之前拦截，避免非法值透传到提供商）
    const genCfg = body.generationConfig;
    if (genCfg?.temperature !== undefined && (genCfg.temperature < 0 || genCfg.temperature > 2)) {
      throw new GatewayError(400, 'invalid_parameter', 'temperature must be between 0 and 2');
    }
    if (genCfg?.topP !== undefined && (genCfg.topP < 0 || genCfg.topP > 1)) {
      throw new GatewayError(400, 'invalid_parameter', 'topP must be between 0 and 1');
    }
    if (genCfg?.maxOutputTokens !== undefined && genCfg.maxOutputTokens <= 0) {
      throw new GatewayError(400, 'invalid_parameter', 'maxOutputTokens must be a positive integer');
    }

    logger.debug(
      {
        contentsCount: body.contents.length,
        hasSystemInstruction: !!body.systemInstruction,
        hasGenerationConfig: !!body.generationConfig,
        hasTools: !!body.tools,
        hasThinkingConfig: !!body.thinkingConfig,
      },
      'Converting Gemini chat request to internal format',
    );

    // 1) 构建消息列表
    const messages = convertToMessages(body.contents, body.systemInstruction);

    // 2) 提取生成控制参数
    const genConfig = body.generationConfig;

    // 3) 转换工具定义
    const tools = convertTools(body.tools);

    // 4) 转换工具选择策略
    const toolChoice = convertToolConfig(body.toolConfig);

    // 5) 转换思考配置（thinkingLevel 按 maxOutputTokens 百分比计算 budget_tokens）
    const thinking = convertThinkingConfig(body.thinkingConfig, genConfig?.maxOutputTokens);

    return {
      messages,
      stream: body.stream ?? false,

      // generationConfig → 扁平参数
      temperature: genConfig?.temperature,
      top_p: genConfig?.topP,
      top_k: genConfig?.topK,
      max_tokens: genConfig?.maxOutputTokens,
      stop: genConfig?.stopSequences,

      // Gemini 无 presence_penalty / frequency_penalty
      // 保持 undefined

      thinking,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: toolChoice,
    };
  }
}

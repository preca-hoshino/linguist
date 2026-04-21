// src/users/gemini/chat/request/index.ts — Gemini 请求适配器（精简编排层）

import type { UserChatRequestAdapter } from '@/model/http/users/types';
import type { InternalChatRequest } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { convertToMessages } from './message-converter';
import { convertThinkingConfig } from './thinking-converter';
import { convertToolConfig, convertTools } from './tool-converter';
import type { GeminiChatRequestBody } from './types';

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
 * 注意：不包含 model 字段，model 由核心流程从 URL 路径提取写入 ModelHttpContext.requestModel
 */
export class GeminiChatRequestAdapter implements UserChatRequestAdapter {
  public toInternal(userReq: unknown): InternalChatRequest {
    if (userReq === undefined || userReq === null || typeof userReq !== 'object') {
      throw new GatewayError(400, 'invalid_request', 'Gemini chat request must include a non-empty contents array');
    }
    const body = userReq as GeminiChatRequestBody;
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Gemini chat request must include a non-empty contents array');
    }

    // 参数范围校验（在适配之前拦截，避免非法值透传到提供商）
    const genCfg = body.generationConfig;
    if (
      genCfg?.temperature !== undefined &&
      (typeof genCfg.temperature !== 'number' || genCfg.temperature < 0 || genCfg.temperature > 2)
    ) {
      throw new GatewayError(400, 'invalid_parameter', 'temperature must be a number between 0 and 2');
    }
    if (genCfg?.topP !== undefined && (typeof genCfg.topP !== 'number' || genCfg.topP < 0 || genCfg.topP > 1)) {
      throw new GatewayError(400, 'invalid_parameter', 'topP must be a number between 0 and 1');
    }
    if (
      genCfg?.topK !== undefined &&
      (typeof genCfg.topK !== 'number' || !Number.isInteger(genCfg.topK) || genCfg.topK < 0)
    ) {
      throw new GatewayError(400, 'invalid_parameter', 'topK must be a non-negative integer');
    }
    if (
      genCfg?.maxOutputTokens !== undefined &&
      (typeof genCfg.maxOutputTokens !== 'number' ||
        !Number.isInteger(genCfg.maxOutputTokens) ||
        genCfg.maxOutputTokens <= 0)
    ) {
      throw new GatewayError(400, 'invalid_parameter', 'maxOutputTokens must be a positive integer');
    }

    // --- thinkingConfig 类型校验 ---
    if (body.thinkingConfig !== undefined) {
      const tc = body.thinkingConfig as unknown;
      if (typeof tc !== 'object' || tc === null || Array.isArray(tc)) {
        throw new GatewayError(400, 'invalid_parameter', 'thinkingConfig must be an object');
      }
      const tcObj = tc as Record<string, unknown>;
      if (tcObj.includeThoughts !== undefined && typeof tcObj.includeThoughts !== 'boolean') {
        throw new GatewayError(400, 'invalid_parameter', 'thinkingConfig.includeThoughts must be a boolean');
      }
      if (
        tcObj.thinkingBudget !== undefined &&
        (typeof tcObj.thinkingBudget !== 'number' ||
          !Number.isInteger(tcObj.thinkingBudget) ||
          tcObj.thinkingBudget < 0)
      ) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          'thinkingConfig.thinkingBudget must be a non-negative integer',
        );
      }
    }

    // --- stream 类型 ---
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      throw new GatewayError(400, 'invalid_parameter', 'stream must be a boolean');
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

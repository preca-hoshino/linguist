// src/users/chat/gemini/request/types.ts — Gemini 请求相关类型定义

// ==================== Gemini 用户请求类型定义 ====================

export interface GeminiTextPart {
  text?: string;
}

export interface GeminiInlineDataPart {
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiFunctionCallPart {
  functionCall?: {
    /** Gemini 2.x+ 支持的函数调用 ID（用于精确关联响应） */
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse?: {
    /** 与 functionCall.id 对应 */
    id?: string;
    name: string;
    response: unknown;
  };
}

export interface GeminiFileDataPart {
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
}

export type GeminiPart = GeminiTextPart &
  GeminiInlineDataPart &
  GeminiFunctionCallPart &
  GeminiFunctionResponsePart &
  GeminiFileDataPart;

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiSystemInstruction {
  role?: string;
  parts: GeminiTextPart[];
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  responseMimeType?: string;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: 'AUTO' | 'NONE' | 'ANY';
    allowedFunctionNames?: string[];
  };
}

/** Gemini 思考级别（定性描述，由适配器转为 budget_tokens 量化） */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface GeminiThinkingConfig {
  includeThoughts?: boolean;
  /** 直接指定 token 预算（优先级高于 thinkingLevel） */
  thinkingBudget?: number;
  /** 思考级别（转为 budget_tokens 统一量化） */
  thinkingLevel?: string;
}

/** Gemini 原生格式请求体 */
export interface GeminiChatRequestBody {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  thinkingConfig?: GeminiThinkingConfig;
  stream?: boolean;
}

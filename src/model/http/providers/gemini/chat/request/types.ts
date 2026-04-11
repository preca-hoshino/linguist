// src/providers/chat/gemini/request/types.ts — Gemini 请求相关类型定义

// ==================== Gemini 请求类型 ====================

/** Gemini 文本 part */
export interface GeminiTextPart {
  text: string;
}

/** Gemini 内联数据 part（多模态） */
export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

/** Gemini 文件引用 part（Google Cloud Storage 或可访问 URI） */
export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

/** Gemini 函数调用 part */
export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

/** Gemini 函数响应 part */
export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: unknown;
  };
}

/** Gemini part 联合类型 */
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

/** Gemini content 对象 */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Gemini systemInstruction */
export interface GeminiSystemInstruction {
  role: 'user';
  parts: GeminiTextPart[];
}

/** Gemini generationConfig */
export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  /** JSON mode 或结构化输出时指定（'application/json' 或 'text/plain'） */
  responseMimeType?: string;
  /** 结构化输出的 JSON Schema（json_schema 模式下使用） */
  responseSchema?: Record<string, unknown>;
}

/** Gemini functionDeclaration */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string | undefined;
  parameters: Record<string, unknown>;
}

/** Gemini tool */
export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/** Gemini toolConfig */
export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'NONE' | 'ANY';
    allowedFunctionNames?: string[];
  };
}

/** Gemini thinkingConfig */
export interface GeminiThinkingConfig {
  includeThoughts: boolean;
  thinkingBudget?: number;
}

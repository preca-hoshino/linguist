// src/providers/chat/gemini/request/tool-converter.ts — Gemini 工具转换

import type { ToolChoice, ToolDefinition } from '@/types';
import type { GeminiFunctionDeclaration, GeminiTool, GeminiToolConfig } from './types';

// ==================== tools 转换 ====================

/**
 * 递归清理 JSON Schema，移除 Gemini 不支持的 null 类型（null 字面量或 "null" 字符串）。
 *
 * Gemini 使用 OpenAPI 3.0 子集，不支持 JSON Schema 中的 type: null / "null"：
 * - properties 中的属性若 type 为 null，则移除该 type 字段
 * - type 数组（如 ["string", "null"]）中过滤掉 null/"null"，若只剩一个则展开为标量
 * - anyOf/oneOf/allOf 中过滤掉 {type: 'null'} / {type: null} 的 schema
 * - 递归处理 properties、items、anyOf/oneOf/allOf 嵌套结构
 */
function cleanSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  // 规范化 type 字段：移除 null / "null"，数组类型过滤 null 成员
  let normalizedType: unknown = schema.type;
  if (normalizedType === null || normalizedType === 'null') {
    normalizedType = undefined;
  } else if (Array.isArray(normalizedType)) {
    const filtered = normalizedType.filter((t) => t !== 'null' && t !== null);
    if (filtered.length === 1) {
      normalizedType = filtered[0];
    } else if (filtered.length > 0) {
      normalizedType = filtered;
    } else {
      normalizedType = undefined;
    }
  }

  // 递归处理 properties
  let cleanedProperties: Record<string, unknown> | undefined;
  if (schema.properties !== null && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, unknown>;
    cleanedProperties = {};
    for (const key of Object.keys(props)) {
      const val = props[key];
      cleanedProperties[key] =
        val !== null && typeof val === 'object' ? cleanSchemaForGemini(val as Record<string, unknown>) : val;
    }
  }

  // 递归处理 items（数组元素 schema）
  const cleanedItems =
    schema.items !== null && typeof schema.items === 'object'
      ? cleanSchemaForGemini(schema.items as Record<string, unknown>)
      : schema.items;

  // 递归处理 anyOf / oneOf / allOf：过滤 null-type schema
  const isNullTypeSchema = (s: unknown): boolean =>
    s !== null &&
    typeof s === 'object' &&
    ((s as Record<string, unknown>).type === 'null' || (s as Record<string, unknown>).type === null);

  const cleanedAnyOf = Array.isArray(schema.anyOf)
    ? (schema.anyOf as unknown[])
        .filter((s) => !isNullTypeSchema(s))
        .map((s) => (s !== null && typeof s === 'object' ? cleanSchemaForGemini(s as Record<string, unknown>) : s))
    : undefined;
  const cleanedOneOf = Array.isArray(schema.oneOf)
    ? (schema.oneOf as unknown[])
        .filter((s) => !isNullTypeSchema(s))
        .map((s) => (s !== null && typeof s === 'object' ? cleanSchemaForGemini(s as Record<string, unknown>) : s))
    : undefined;
  const cleanedAllOf = Array.isArray(schema.allOf)
    ? (schema.allOf as unknown[])
        .filter((s) => !isNullTypeSchema(s))
        .map((s) => (s !== null && typeof s === 'object' ? cleanSchemaForGemini(s as Record<string, unknown>) : s))
    : undefined;

  // 重新组装：从原始 schema 中剔除特殊字段，再按清理后的值合并
  const {
    type: _type,
    properties: _props,
    items: _items,
    anyOf: _anyOf,
    oneOf: _oneOf,
    allOf: _allOf,
    ...rest
  } = schema;
  const result: Record<string, unknown> = { ...rest };

  if (normalizedType !== undefined) {
    result.type = normalizedType;
  }
  if (cleanedProperties !== undefined) {
    result.properties = cleanedProperties;
  }

  if (cleanedItems !== undefined) {
    result.items = cleanedItems;
  }
  if (cleanedAnyOf !== undefined && cleanedAnyOf.length > 0) {
    result.anyOf = cleanedAnyOf;
  }
  if (cleanedOneOf !== undefined && cleanedOneOf.length > 0) {
    result.oneOf = cleanedOneOf;
  }
  if (cleanedAllOf !== undefined && cleanedAllOf.length > 0) {
    result.allOf = cleanedAllOf;
  }

  return result;
}

/**
 * 规范化函数参数 schema，确保符合 Gemini 要求：
 * - 顶层必须是 type: "object" 的 JSON Schema
 * - 保留原有 properties（而非清空：当 type 不是 "object" 时仍保留字段）
 * - 递归清理所有层级中的 null 类型（null 字面量或 "null" 字符串）
 */
function normalizeParameters(
  parameters: ToolDefinition['function']['parameters'] | null | undefined,
): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} };
  }

  const cleaned = cleanSchemaForGemini(parameters);

  // 确保顶层 type 是 'object'
  if (cleaned.type !== 'object') {
    cleaned.type = 'object';
    if (cleaned.properties === undefined) {
      cleaned.properties = {};
    }
  }

  return cleaned;
}

/**
 * InternalToolDefinition[] → Gemini tools[] (functionDeclarations)
 * Gemini 将所有函数声明放在一个 Tool 对象内
 */
export function convertTools(tools: ToolDefinition[]): GeminiTool[] {
  const declarations: GeminiFunctionDeclaration[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: normalizeParameters(t.function.parameters),
  }));

  return [{ functionDeclarations: declarations }];
}

// ==================== toolConfig 转换 ====================

/**
 * OpenAI tool_choice → Gemini toolConfig.functionCallingConfig
 * - 'auto'     → mode: 'AUTO'
 * - 'none'     → mode: 'NONE'
 * - 'required' → mode: 'ANY'
 * - { function: { name } } → mode: 'ANY' + allowedFunctionNames
 */
export function convertToolChoice(choice: ToolChoice): GeminiToolConfig {
  if (typeof choice === 'string') {
    const modeMap: Record<string, 'AUTO' | 'NONE' | 'ANY'> = {
      auto: 'AUTO',
      none: 'NONE',
      required: 'ANY',
    };
    return {
      functionCallingConfig: {
        mode: modeMap[choice] ?? 'AUTO',
      },
    };
  }

  // 指定函数名称
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [choice.function.name],
    },
  };
}

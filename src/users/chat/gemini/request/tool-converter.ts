// src/users/chat/gemini/request/tool-converter.ts — Gemini 工具及工具选择策略转换

import type { ToolDefinition, ToolChoice } from '../../../../types';
import type { GeminiTool, GeminiToolConfig } from './types';

// ==================== Schema 规范化 ====================

/**
 * 将 Gemini Schema 中的大写类型名递归转换为标准 JSON Schema 小写类型名，
 * 并移除 OpenAI 兼容 API 不支持的 null 类型。
 *
 * Gemini 使用 "STRING" / "OBJECT" / "ARRAY" / "BOOLEAN" / "NUMBER" / "INTEGER" / "NULL"，
 * 而 OpenAI 兼容 API 要求小写的 "string" / "object" 等，且不支持 null 类型。
 *
 * 处理规则：
 * - type 字符串 → 转为小写；"null" / null 字面量 → 移除 type 字段
 * - type 数组（如 ["STRING", "NULL"]）→ 过滤 null 成员并小写；单元素时展开为标量
 * - anyOf/oneOf/allOf 中 {type: 'null'} / {type: null} 的条目 → 整个过滤掉
 * - 递归处理 properties、items、anyOf/oneOf/allOf 子 schema
 */
function normalizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // 剔除 type、properties、items、anyOf/oneOf/allOf，后面按需重新组装
  const { type, properties, items, anyOf, oneOf, allOf, ...rest } = schema;
  const result: Record<string, unknown> = { ...rest };

  // 处理 type 字段：大写 → 小写；null 字面量 / "null" / "NULL" → 省略
  if (type !== null && type !== 'null' && type !== 'NULL') {
    if (Array.isArray(type)) {
      // 类型数组：过滤 null 成员并小写
      const filtered = (type as unknown[])
        .filter((t) => t !== null && t !== 'null' && t !== 'NULL')
        .map((t): unknown => (typeof t === 'string' ? t.toLowerCase() : t));
      if (filtered.length === 1) {
        result['type'] = filtered[0];
      } else if (filtered.length > 1) {
        result['type'] = filtered;
      }
      // length === 0 时省略 type
    } else if (typeof type === 'string') {
      result['type'] = type.toLowerCase();
    } else if (type !== undefined) {
      result['type'] = type;
    }
  }

  // 递归处理 properties
  if (properties !== null && typeof properties === 'object') {
    const props = properties as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      const val = props[key];
      normalized[key] =
        val !== null && typeof val === 'object' ? normalizeGeminiSchema(val as Record<string, unknown>) : val;
    }
    result['properties'] = normalized;
  }

  // 递归处理 items（数组元素 schema）
  if (items !== null && typeof items === 'object') {
    result['items'] = normalizeGeminiSchema(items as Record<string, unknown>);
  }

  // 递归处理 anyOf / oneOf / allOf：过滤 null-type 条目
  const isNullType = (s: unknown): boolean => {
    if (s === null || typeof s !== 'object') {
      return false;
    }
    const t = (s as Record<string, unknown>)['type'];
    return t === null || t === 'null' || t === 'NULL';
  };
  const cleanArr = (arr: unknown): unknown[] | undefined => {
    if (!Array.isArray(arr)) {
      return undefined;
    }
    return (arr as unknown[])
      .filter((s) => !isNullType(s))
      .map((s): unknown =>
        s !== null && typeof s === 'object' ? normalizeGeminiSchema(s as Record<string, unknown>) : s,
      );
  };

  const cleanedAnyOf = cleanArr(anyOf);
  if (cleanedAnyOf !== undefined) {
    result['anyOf'] = cleanedAnyOf;
  }
  const cleanedOneOf = cleanArr(oneOf);
  if (cleanedOneOf !== undefined) {
    result['oneOf'] = cleanedOneOf;
  }
  const cleanedAllOf = cleanArr(allOf);
  if (cleanedAllOf !== undefined) {
    result['allOf'] = cleanedAllOf;
  }

  return result;
}

/**
 * 规范化工具 parameters，确保符合 OpenAI 兼容 API 的要求：
 * - 顶层必须是 type: "object"
 * - parameters 为 null/undefined 时返回空对象 schema
 */
function normalizeToolParameters(parameters: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} };
  }
  const normalized = normalizeGeminiSchema(parameters);
  if (normalized['type'] !== 'object') {
    normalized['type'] = 'object';
    if (normalized['properties'] === undefined) {
      normalized['properties'] = {};
    }
  }
  return normalized;
}

// ==================== 工具转换 ====================

/**
 * Gemini tools[].functionDeclarations → ToolDefinition[]
 */
export function convertTools(tools?: GeminiTool[]): ToolDefinition[] {
  if (!tools) {
    return [];
  }

  const result: ToolDefinition[] = [];
  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const fd of tool.functionDeclarations) {
        result.push({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description,
            parameters: normalizeToolParameters(fd.parameters),
          },
        });
      }
    }
  }
  return result;
}

// ==================== toolConfig 转换 ====================

/**
 * Gemini toolConfig → ToolChoice
 * - AUTO → 'auto'
 * - NONE → 'none'
 * - ANY  → 'required'（无指定函数名时）
 * - ANY + allowedFunctionNames[0] → { function: { name } }
 */
export function convertToolConfig(toolConfig?: GeminiToolConfig): ToolChoice | undefined {
  if (!toolConfig?.functionCallingConfig) {
    return undefined;
  }

  const fcc = toolConfig.functionCallingConfig;
  const mode = fcc.mode ?? 'AUTO';

  if (mode === 'NONE') {
    return 'none';
  }
  if (mode === 'AUTO') {
    return 'auto';
  }

  // ANY
  if (fcc.allowedFunctionNames !== undefined && fcc.allowedFunctionNames.length > 0) {
    const fnName = fcc.allowedFunctionNames[0];
    if (fnName !== undefined && fnName.length > 0) {
      return {
        type: 'function',
        function: { name: fnName },
      };
    }
  }
  return 'required';
}

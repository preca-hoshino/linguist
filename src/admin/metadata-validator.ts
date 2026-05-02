/**
 * Metadata 字段校验工具
 *
 * 遵循 admin-api.instructions.md 第 8 节规范：
 * - 最多 50 个键
 * - 键名最大 40 字符
 * - 值最大 500 字符
 * - 禁止存储敏感数据（PII、凭据等不做自动检测，由调用方负责）
 */

import { GatewayError } from '@/utils';

/** Metadata 校验约束 */
const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 500;

/**
 * 校验 metadata 对象是否符合规范。
 * 若 metadata 为 undefined 或 null，视为空对象通过校验。
 *
 * @throws GatewayError 400 若校验失败
 */
export function validateMetadata(metadata: unknown): asserts metadata is Record<string, string> | undefined {
  if (metadata === undefined || metadata === null) {
    return;
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new GatewayError(400, 'invalid_request', 'Field "metadata" must be a JSON object').withParam('metadata');
  }

  const obj = metadata as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length > MAX_KEYS) {
    throw new GatewayError(400, 'invalid_request', `Metadata exceeds maximum of ${String(MAX_KEYS)} keys`).withParam(
      'metadata',
    );
  }

  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH) {
      throw new GatewayError(
        400,
        'invalid_request',
        `Metadata key "${key}" exceeds maximum length of ${String(MAX_KEY_LENGTH)} characters`,
      ).withParam('metadata');
    }

    const value = obj[key];
    if (typeof value !== 'string') {
      throw new GatewayError(400, 'invalid_request', `Metadata value for key "${key}" must be a string`).withParam(
        'metadata',
      );
    }

    if (value.length > MAX_VALUE_LENGTH) {
      throw new GatewayError(
        400,
        'invalid_request',
        `Metadata value for key "${key}" exceeds maximum length of ${String(MAX_VALUE_LENGTH)} characters`,
      ).withParam('metadata');
    }
  }
}

/**
 * 将 metadata 对象序列化为 JSON 字符串（用于 DB 写入）。
 * 返回 undefined 表示不更新该字段。
 */
export function serializeMetadata(metadata: unknown): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return JSON.stringify(metadata);
}

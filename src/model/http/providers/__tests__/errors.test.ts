import { extractErrorObj, extractString, fallbackByStatus, tryParseJson } from '../errors';

describe('Providers Base Errors Utilities', () => {
  describe('fallbackByStatus', () => {
    it('应该正确映射常见的 HTTP 状态码', () => {
      expect(fallbackByStatus(401)).toEqual({ gatewayStatusCode: 401, gatewayErrorCode: 'authentication_error' });
      expect(fallbackByStatus(403)).toEqual({ gatewayStatusCode: 403, gatewayErrorCode: 'permission_denied' });
      expect(fallbackByStatus(404)).toEqual({ gatewayStatusCode: 404, gatewayErrorCode: 'model_not_found' });
      expect(fallbackByStatus(429)).toEqual({ gatewayStatusCode: 429, gatewayErrorCode: 'rate_limit_exceeded' });
      expect(fallbackByStatus(500)).toEqual({ gatewayStatusCode: 502, gatewayErrorCode: 'provider_error' });
      expect(fallbackByStatus(503)).toEqual({ gatewayStatusCode: 502, gatewayErrorCode: 'provider_error' });
      expect(fallbackByStatus(400)).toEqual({ gatewayStatusCode: 400, gatewayErrorCode: 'invalid_request' });
      expect(fallbackByStatus(418)).toEqual({ gatewayStatusCode: 418, gatewayErrorCode: 'provider_error' });
    });
  });

  describe('extractString', () => {
    it('应该提取字符串', () => {
      expect(extractString({ key: 'val' }, 'key')).toBe('val');
    });

    it('应该转换 number 和 boolean', () => {
      expect(extractString({ key: 123 }, 'key')).toBe('123');
      expect(extractString({ key: true }, 'key')).toBe('true');
    });

    it('应该忽略 object 等其他类型并返回 undefined', () => {
      expect(extractString({ key: {} }, 'key')).toBeUndefined();
      expect(extractString({ key: null }, 'key')).toBeUndefined();
    });
  });

  describe('extractErrorObj', () => {
    it('应该从解析后的 JSON 中提取 error 对象', () => {
      expect(extractErrorObj({ error: { message: 'err' } })).toEqual({ message: 'err' });
    });

    it('应该回退如果 error 不是对象或为空', () => {
      expect(extractErrorObj({ error: 'not-obj' })).toBeNull();
      expect(extractErrorObj({ error: null })).toBeNull();
      expect(extractErrorObj(null)).toBeNull();
      expect(extractErrorObj('string')).toBeNull();
    });
  });

  describe('tryParseJson', () => {
    it('应该返回解析的结果', () => {
      expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('应该在解析失败时返回 null', () => {
      expect(tryParseJson('invalid')).toBeNull();
    });
  });
});

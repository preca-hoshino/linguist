import { DNS_NAMESPACE, v4, v5 } from '../uuid';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('v4', () => {
  it('should return a valid UUID v4 string', () => {
    const id = v4();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('should produce unique values on repeated calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => v4()));
    expect(ids.size).toBe(100);
  });
});

describe('v5', () => {
  it('should return a valid UUID format string', () => {
    const id = v5('test', DNS_NAMESPACE);
    expect(id).toMatch(UUID_RE);
  });

  it('should set version bits to 5 (index 12 = 5)', () => {
    const id = v5('hello', DNS_NAMESPACE);
    // 第 14 个字符（位置 13）在 UUID 中对应 version nibble（格式: xxxxxxxx-xxxx-Vxxx-...）
    expect(id[14]).toBe('5');
  });

  it('should set variant bits to RFC4122 (8/9/a/b at the 20th char position)', () => {
    const id = v5('hello', DNS_NAMESPACE);
    // UUID 格式: xxxxxxxx-xxxx-xxxx-Vxxx-xxxxxx...  V 是版本号，variant 在下一段的第一个字符
    // 8-4-4-4-12: 8+1+4+1+4+1+4+1 = 24, 第 19 个字符是第一个 hyphen 后的第 4+1+4+1+4+1+4 = 20
    // 实际上 variant 在 "xxxxxxxx-xxxx-xxxx-xxxx-Nxxx..." 的 N 位置
    // 位置: 8 + 1 + 4 + 1 + 4 + 1 + 4 = 23, 位置 23 字符 = 第三段第四位
    // variant 是位置 19: 8 + 1 + 4 + 1 + 4 = 18, offset 19
    expect('89ab').toContain(id[19]);
  });

  it('should produce deterministic output for same name and namespace', () => {
    const a = v5('same-name', DNS_NAMESPACE);
    const b = v5('same-name', DNS_NAMESPACE);
    expect(a).toBe(b);
  });

  it('should produce different output for different names', () => {
    const a = v5('name-a', DNS_NAMESPACE);
    const b = v5('name-b', DNS_NAMESPACE);
    expect(a).not.toBe(b);
  });

  it('should produce different output for different namespaces', () => {
    const customNs = '6ba7b810-9dad-11d1-80b4-00c04fd430c9';
    const a = v5('name', DNS_NAMESPACE);
    const b = v5('name', customNs);
    expect(a).not.toBe(b);
  });

  it('should handle empty string name', () => {
    const id = v5('', DNS_NAMESPACE);
    expect(id).toMatch(UUID_RE);
    // 确定性：空字符串 repeat
    expect(v5('', DNS_NAMESPACE)).toBe(id);
  });
});

describe('DNS_NAMESPACE', () => {
  it('should be the RFC 4122 DNS namespace UUID', () => {
    expect(DNS_NAMESPACE).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  });

  it('should be a valid UUID', () => {
    expect(DNS_NAMESPACE).toMatch(UUID_RE);
  });
});

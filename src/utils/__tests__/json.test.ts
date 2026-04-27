import { safeParseJson } from '../json';

describe('safeParseJson', () => {
  it('should parse valid JSON object', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('should parse valid JSON array', () => {
    expect(safeParseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('should parse valid JSON string', () => {
    expect(safeParseJson('"hello"')).toEqual('hello');
  });

  it('should parse valid JSON number', () => {
    expect(safeParseJson('42')).toEqual(42);
  });

  it('should fallback to { result: value } for invalid JSON', () => {
    const result = safeParseJson('not-json');
    expect(result).toEqual({ result: 'not-json' });
  });

  it('should fallback for empty string', () => {
    const result = safeParseJson('');
    expect(result).toEqual({ result: '' });
  });

  it('should fallback for malformed object', () => {
    const result = safeParseJson('{broken');
    expect(result).toEqual({ result: '{broken' });
  });
});

import { buildBatchInsert, buildInClause, buildUpdateSet } from '../query-builder';

describe('buildUpdateSet', () => {
  it('should build SET clause with given updates', () => {
    const result = buildUpdateSet({ name: 'foo', base_url: 'http://example.com' });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.setClause).toBe('name = $1, base_url = $2');
      expect(result.values).toEqual(['foo', 'http://example.com']);
      expect(result.nextIdx).toBe(3);
    }
  });

  it('should skip undefined values', () => {
    const result = buildUpdateSet({ name: 'bar', kind: undefined, base_url: 'http://x.com' });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.setClause).toBe('name = $1, base_url = $2');
      expect(result.values).toEqual(['bar', 'http://x.com']);
    }
  });

  it('should return null when all values are undefined', () => {
    const result = buildUpdateSet({ a: undefined, b: undefined });
    expect(result).toBeNull();
  });

  it('should handle empty object by returning null', () => {
    const result = buildUpdateSet({});
    expect(result).toBeNull();
  });

  it('should use custom start index', () => {
    const result = buildUpdateSet({ x: 1, y: 2 }, 5);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.setClause).toBe('x = $5, y = $6');
      expect(result.nextIdx).toBe(7);
    }
  });

  it('should handle single field', () => {
    const result = buildUpdateSet({ only: 'one' });
    expect(result).not.toBeNull();
    if (result) {
      expect(result.setClause).toBe('only = $1');
      expect(result.values).toEqual(['one']);
    }
  });
});

describe('buildBatchInsert', () => {
  it('should build VALUES clause for multiple rows', () => {
    const result = buildBatchInsert(
      [
        ['a', 1],
        ['b', 2],
      ],
      2,
    );
    expect(result.valuesClause).toBe('($1, $2), ($3, $4)');
    expect(result.values).toEqual(['a', 1, 'b', 2]);
    expect(result.nextIdx).toBe(5);
  });

  it('should handle single row', () => {
    const result = buildBatchInsert([['x']], 1);
    expect(result.valuesClause).toBe('($1)');
    expect(result.values).toEqual(['x']);
    expect(result.nextIdx).toBe(2);
  });

  it('should use custom start index', () => {
    const result = buildBatchInsert([['a'], ['b']], 1, 10);
    expect(result.valuesClause).toBe('($10), ($11)');
    expect(result.nextIdx).toBe(12);
  });

  it('should throw if row length does not match columnsPerRow', () => {
    expect(() => {
      buildBatchInsert([['a', 'b']], 1);
    }).toThrow('Expected 1 columns per row, got 2');
  });

  it('should handle empty rows array', () => {
    const result = buildBatchInsert([], 3);
    expect(result.valuesClause).toBe('');
    expect(result.values).toEqual([]);
    expect(result.nextIdx).toBe(1);
  });
});

describe('buildInClause', () => {
  it('should build IN clause from string array', () => {
    const result = buildInClause('status', ['A', 'B', 'C']);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.clause).toBe('status IN ($1, $2, $3)');
      expect(result.values).toEqual(['A', 'B', 'C']);
      expect(result.nextIdx).toBe(4);
    }
  });

  it('should build IN clause from comma-separated string', () => {
    const result = buildInClause('status', 'A, B, C');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.clause).toBe('status IN ($1, $2, $3)');
      expect(result.values).toEqual(['A', 'B', 'C']);
    }
  });

  it('should return null for undefined tags', () => {
    expect(buildInClause('col', undefined)).toBeNull();
  });

  it('should return null for null tags', () => {
    expect(buildInClause('col', null)).toBeNull();
  });

  it('should return null for empty array', () => {
    expect(buildInClause('col', [])).toBeNull();
  });

  it('should return null for empty string after split', () => {
    expect(buildInClause('col', '  ,  , ')).toBeNull();
  });

  it('should use custom start index', () => {
    const result = buildInClause('col', ['X', 'Y'], 5);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.clause).toBe('col IN ($5, $6)');
      expect(result.nextIdx).toBe(7);
    }
  });

  it('should handle single value', () => {
    const result = buildInClause('col', ['only']);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.clause).toBe('col IN ($1)');
    }
  });
});

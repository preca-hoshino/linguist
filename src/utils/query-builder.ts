// src/utils/query-builder.ts — SQL 动态查询构建工具

/**
 * 动态构建 UPDATE SET 子句
 *
 * 从传入的字段映射中过滤掉值为 undefined 的条目，
 * 生成参数化的 SET 子句和对应的值数组。
 *
 * @param updates - 列名 → 值的映射（值为 undefined 的字段会被跳过）
 * @param startIdx - 参数占位符起始索引（默认 1）
 * @returns { setClause, values, nextIdx } 或 null（无字段可更新时）
 *
 * @example
 * const result = buildUpdateSet({ name: 'foo', kind: undefined, base_url: 'http://...' });
 * // result = { setClause: 'name = $1, base_url = $2', values: ['foo', 'http://...'], nextIdx: 3 }
 */
export function buildUpdateSet(
  updates: Record<string, unknown>,
  startIdx = 1,
): { setClause: string; values: unknown[]; nextIdx: number } | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = startIdx;

  for (const [column, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${column} = $${String(idx++)}`);
      values.push(value);
    }
  }

  if (fields.length === 0) {
    return null;
  }

  return { setClause: fields.join(', '), values, nextIdx: idx };
}

/**
 * 构建批量 INSERT 的 VALUES 子句
 *
 * @param rows - 每行的值数组
 * @param columnsPerRow - 每行的列数
 * @param startIdx - 参数占位符起始索引（默认 1）
 * @returns { valuesClause, values, nextIdx }
 *
 * @example
 * const result = buildBatchInsert([[id, 'a', 1, 0], [id, 'b', 2, 1]], 4);
 * // result.valuesClause = '($1, $2, $3, $4), ($5, $6, $7, $8)'
 * // result.values = [id, 'a', 1, 0, id, 'b', 2, 1]
 */
export function buildBatchInsert(
  rows: unknown[][],
  columnsPerRow: number,
  startIdx = 1,
): { valuesClause: string; values: unknown[]; nextIdx: number } {
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let idx = startIdx;

  for (const row of rows) {
    if (row.length !== columnsPerRow) {
      throw new Error(`Expected ${String(columnsPerRow)} columns per row, got ${String(row.length)}`);
    }
    const rowPlaceholders = row.map(() => `$${String(idx++)}`);
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
    values.push(...row);
  }

  return { valuesClause: placeholders.join(', '), values, nextIdx: idx };
}

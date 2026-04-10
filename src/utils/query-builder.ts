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

/**
 * 构建多选（多 Tag）IN 子句
 *
 * @param column - 列名拼装格式，如 'a.status'
 * @param tags - 筛选的标签数组，例如 ['completed', 'processing'] 或以逗号分割的单字符串
 * @param startIdx - 参数占位符起始索引
 * @returns { clause: string; values: string[]; nextIdx: number } | null
 *
 * @example
 * const result = buildInClause('status', ['A', 'B'], 1);
 * // result.clause = 'status IN ($1, $2)'
 * // result.values = ['A', 'B']
 */
export function buildInClause(
  column: string,
  tags: string | string[] | undefined | null,
  startIdx = 1,
): { clause: string; values: string[]; nextIdx: number } | null {
  if (tags === undefined || tags === null) {
    return null;
  }

  // 兼容单字符串(逗号分隔)或数组
  const tagsArray = Array.isArray(tags)
    ? tags
    : tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  if (tagsArray.length === 0) {
    return null;
  }

  const placeholders = tagsArray.map((_, i) => `$${startIdx + i}`);
  return {
    clause: `${column} IN (${placeholders.join(', ')})`,
    values: tagsArray,
    nextIdx: startIdx + tagsArray.length,
  };
}

import type { ReactNode } from "react";

export interface MiniTableColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

interface MiniTableCardProps<T> {
  columns: MiniTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  maxHeight?: number;
  emptyText?: string;
}

export function MiniTableCard<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  maxHeight = 320,
  emptyText = "当前暂无明细记录",
}: MiniTableCardProps<T>) {
  if (rows.length === 0) {
    return <div className="monitoring-empty">{emptyText}</div>;
  }

  return (
    <div className="monitoring-table-wrap" style={{ maxHeight }}>
      <table className="monitoring-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={col.align === "right" ? "align-right" : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={rowKey(row, idx)}
              className={onRowClick ? "clickable" : undefined}
              onClick={onRowClick ? () => { onRowClick(row); } : undefined}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={col.align === "right" ? "align-right" : undefined}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

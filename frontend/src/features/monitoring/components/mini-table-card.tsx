import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-md border" style={{ maxHeight }}>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-muted/80 backdrop-blur-xs">
          <TableRow>
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  "text-xs",
                  col.align === "right" ? "text-end" : undefined,
                )}
              >
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, idx) => (
            <TableRow
              key={rowKey(row, idx)}
              className={onRowClick ? "cursor-pointer" : undefined}
              onClick={
                onRowClick
                  ? () => {
                      onRowClick(row);
                    }
                  : undefined
              }
            >
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn("text-xs", col.align === "right" ? "text-end" : undefined)}
                >
                  {col.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

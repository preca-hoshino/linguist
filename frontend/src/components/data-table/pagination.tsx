import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { Table } from "@tanstack/react-table";
import { cn, getPageNumbers } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  className?: string;
  pageSizeOptions?: number[];
  totalRows?: number;
}

export function DataTablePagination<TData>({
  table,
  className,
  pageSizeOptions = [10, 20, 50, 100],
  totalRows,
}: DataTablePaginationProps<TData>) {
  const currentPage = table.getState().pagination.pageIndex + 1;
  const totalPages = Math.max(1, table.getPageCount());
  const pageNumbers = getPageNumbers(currentPage, totalPages);
  const pageSize = table.getState().pagination.pageSize;

  return (
    <div
      className={cn(
        "flex flex-col-reverse items-center justify-between gap-4 overflow-clip px-2 sm:flex-row",
        className,
      )}
    >
      <div className="flex w-full items-center justify-between sm:w-auto sm:gap-4">
        <div className="flex items-center gap-2">
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              table.setPageSize(Number(value));
            }}
          >
            <SelectTrigger className="h-8 w-[76px]">
              <SelectValue placeholder={String(pageSize)} />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">条 / 页</p>
        </div>

        {totalRows !== undefined ? (
          <p className="text-sm text-muted-foreground">
            共 <span className="mono font-medium text-foreground">{totalRows.toLocaleString("en-US")}</span> 条
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-4 sm:gap-6">
        <div className="hidden text-sm font-medium text-muted-foreground md:block">
          第 {currentPage} / {totalPages} 页
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            className="hidden size-8 p-0 md:inline-flex"
            onClick={() => {
              table.setPageIndex(0);
            }}
            disabled={!table.getCanPreviousPage()}
            aria-label="首页"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            className="size-8 p-0"
            onClick={() => {
              table.previousPage();
            }}
            disabled={!table.getCanPreviousPage()}
            aria-label="上一页"
          >
            <ChevronLeft className="size-4" />
          </Button>

          {pageNumbers.map((pageNumber, index) => (
            <div key={`${pageNumber}-${index}`} className="flex items-center">
              {pageNumber === "..." ? (
                <span className="px-1 text-sm text-muted-foreground">…</span>
              ) : (
                <Button
                  variant={currentPage === pageNumber ? "default" : "outline"}
                  className="h-8 min-w-8 px-2 text-xs"
                  onClick={() => {
                    table.setPageIndex(pageNumber - 1);
                  }}
                >
                  {pageNumber}
                </Button>
              )}
            </div>
          ))}

          <Button
            variant="outline"
            className="size-8 p-0"
            onClick={() => {
              table.nextPage();
            }}
            disabled={!table.getCanNextPage()}
            aria-label="下一页"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            className="hidden size-8 p-0 md:inline-flex"
            onClick={() => {
              table.setPageIndex(totalPages - 1);
            }}
            disabled={!table.getCanNextPage()}
            aria-label="末页"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

import { X } from "lucide-react";
import type { Table } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTableFacetedFilter } from "./faceted-filter";
import { DataTableViewOptions } from "./view-options";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  searchPlaceholder?: string;
  searchKey?: string;
  columnLabels?: Record<string, string>;
  filters?: {
    columnId: string;
    title: string;
    options: {
      label: string;
      value: string;
      icon?: React.ComponentType<{ className?: string }>;
    }[];
  }[];
  extraControls?: React.ReactNode;
}

export function DataTableToolbar<TData>({
  table,
  searchPlaceholder = "筛选…",
  searchKey,
  columnLabels,
  filters = [],
  extraControls,
}: DataTableToolbarProps<TData>) {
  const globalFilterVal =
    typeof table.getState().globalFilter === "string" ? (table.getState().globalFilter as string) : "";
  const isFiltered = table.getState().columnFilters.length > 0 || Boolean(globalFilterVal);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {searchKey ? (
          <Input
            placeholder={searchPlaceholder}
            value={(table.getColumn(searchKey)?.getFilterValue() as string | undefined) ?? ""}
            onChange={(event) => {
              table.getColumn(searchKey)?.setFilterValue(event.target.value);
            }}
            className="h-8 w-44 lg:w-64"
          />
        ) : (
          <Input
            placeholder={searchPlaceholder}
            value={globalFilterVal}
            onChange={(event) => {
              table.setGlobalFilter(event.target.value);
            }}
            className="h-8 w-44 lg:w-64"
          />
        )}

        {filters.map((filter) => {
          const column = table.getColumn(filter.columnId);
          if (!column) return null;
          return (
            <DataTableFacetedFilter
              key={filter.columnId}
              column={column}
              title={filter.title}
              options={filter.options}
            />
          );
        })}

        {extraControls}

        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              table.resetColumnFilters();
              table.setGlobalFilter("");
            }}
            className="h-8 px-2.5"
          >
            重置
            <X className="ms-1.5 size-3.5" />
          </Button>
        ) : null}
      </div>
      <DataTableViewOptions table={table} columnLabels={columnLabels} />
    </div>
  );
}

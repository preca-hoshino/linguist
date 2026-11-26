import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from "@tanstack/react-table";
import { X } from "lucide-react";
import { formatInteger } from "@/features/dashboard/api";
import type { FilterEntityItem, RecentRequestItem } from "@/features/dashboard/types";
import { LobeIcon } from "@/components/lobe-icon";
import { DataTablePagination, DataTableViewOptions } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { billingStatus, money } from "../api";

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}:${sec}`;
}

function ttftColorClass(ttftMs: number): string {
  if (ttftMs <= 350) return "text-emerald-600 dark:text-emerald-400";
  if (ttftMs <= 1200) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function statusBadgeVariant(statusCode: number): "secondary" | "outline" | "destructive" {
  if (statusCode >= 200 && statusCode < 400) return "secondary";
  if (statusCode >= 500 || statusCode === 429) return "destructive";
  return "outline";
}

const COLUMN_LABELS: Record<string, string> = {
  time: "时间 / 状态码",
  model: "模型显示名",
  callModel: "调用模型 / 项目",
  provider: "提供商",
  tokens: "Token 分布",
  billing: "费用明细",
  ttft: "耗时 (TTFT)",
  speed: "速率 (tok/s)",
};

interface RequestsTableProps {
  items: RecentRequestItem[];
  projects: FilterEntityItem[];
  providers: FilterEntityItem[];
  models: FilterEntityItem[];
  selectedProject: string;
  selectedProvider: string;
  selectedModel: string;
  selectedStatus: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  displayCurrency: string | null;
  onProjectChange: (projectId: string) => void;
  onProviderChange: (providerId: string) => void;
  onModelChange: (modelId: string) => void;
  onStatusChange: (status: string) => void;
  onResetFilters: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onSelectBilling: (requestUid: string) => void;
}

export function RequestsTable({
  items,
  projects,
  providers,
  models,
  selectedProject,
  selectedProvider,
  selectedModel,
  selectedStatus,
  page,
  pageSize,
  total,
  totalPages,
  displayCurrency,
  onProjectChange,
  onProviderChange,
  onModelChange,
  onStatusChange,
  onResetFilters,
  onPageChange,
  onPageSizeChange,
  onSelectBilling,
}: RequestsTableProps) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const columns = useMemo<ColumnDef<RecentRequestItem>[]>(
    () => [
      {
        id: "time",
        accessorKey: "createdAt",
        header: "时间",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-1">
              <div className="mono text-xs">{formatShortTime(item.createdAt)}</div>
              <div className="flex items-center gap-1">
                <Badge
                  variant={statusBadgeVariant(item.statusCode)}
                  className="mono px-1.5 py-0 text-[10px]"
                >
                  {item.statusCode}
                </Badge>
                {item.attemptIndex > 1 ? (
                  <Badge variant="outline" className="mono px-1 py-0 text-[10px]">
                    #{item.attemptIndex}
                  </Badge>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "model",
        accessorKey: "modelName",
        header: "模型显示名",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center gap-2">
              <LobeIcon slug={item.modelIcon} label={item.modelName} size={18} />
              <span className="max-w-44 truncate font-medium">{item.modelName}</span>
            </div>
          );
        },
      },
      {
        id: "callModel",
        accessorKey: "modelId",
        header: "调用标识",
        cell: ({ row }) => {
          const item = row.original;
          const showCallSub = item.callModelId !== item.modelId;
          return (
            <div className="space-y-0.5">
              <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                {item.modelId}
              </Badge>
              <div className="mono text-[11px] text-muted-foreground">
                {showCallSub ? `call: ${item.callModelId} · ` : ""}
                {item.projectName}
              </div>
            </div>
          );
        },
      },
      {
        id: "provider",
        accessorKey: "providerName",
        header: "提供商",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex items-center gap-2">
              <LobeIcon slug={item.providerIcon} label={item.providerName} size={16} />
              <span className="text-sm">{item.providerName}</span>
            </div>
          );
        },
      },
      {
        id: "tokens",
        accessorKey: "totalTokens",
        header: "Token 分布",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="flex max-w-xs flex-wrap gap-1">
              <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                <span className="text-muted-foreground">入</span>
                {formatInteger(item.inputTokens)}
              </Badge>
              <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                <span className="text-muted-foreground">出</span>
                {formatInteger(item.outputTokens)}
              </Badge>
              <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                <span className="text-muted-foreground">缓</span>
                {formatInteger(item.cacheReadTokens)}
              </Badge>
              {item.cacheCreationTokens > 0 ? (
                <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                  <span className="text-muted-foreground">缓写</span>
                  {formatInteger(item.cacheCreationTokens)}
                </Badge>
              ) : null}
              {item.reasoningTokens > 0 ? (
                <Badge variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                  <span className="text-muted-foreground">思</span>
                  {formatInteger(item.reasoningTokens)}
                </Badge>
              ) : null}
              {Object.entries(item.extraTokens).map(([key, val]) => (
                <Badge key={key} variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
                  <span className="text-muted-foreground">{key}</span>
                  {formatInteger(val)}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: "billing",
        accessorKey: "billingAmount",
        header: "费用",
        cell: ({ row }) => {
          const item = row.original;
          const hasCostLabel = item.billingAmount !== null || item.billingStatus !== null;
          return (
            <div className="mono text-xs">
              {hasCostLabel ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mono h-auto p-0 text-xs"
                  onClick={() => {
                    onSelectBilling(item.requestUid);
                  }}
                >
                  {item.billingAmount === null
                    ? billingStatus(item.billingStatus)
                    : `${item.billingStatus === "estimated" ? "估算 " : ""}${money(item.billingAmount, item.billingCurrency)}`}
                </Button>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {item.billingConvertedAmount &&
              displayCurrency &&
              item.billingCurrency !== displayCurrency ? (
                <div className="text-[11px] text-muted-foreground">
                  ≈ {money(item.billingConvertedAmount, displayCurrency)}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "ttft",
        accessorKey: "ttftMs",
        header: () => <div className="text-end">耗时 (TTFT)</div>,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="text-end">
              <div className={`mono text-xs font-semibold ${ttftColorClass(item.ttftMs)}`}>
                {Math.round(item.ttftMs)} ms
              </div>
              <div className="mono text-[11px] text-muted-foreground">
                总 {(item.totalDurationMs / 1000).toFixed(2)}s
              </div>
            </div>
          );
        },
      },
      {
        id: "speed",
        accessorKey: "decodeTps",
        header: () => <div className="text-end">速率 (tok/s)</div>,
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div
              className="text-end"
              title={`E2E: ${item.e2eTps.toFixed(1)} tok/s · Rule: ${item.routeRuleId} · Attempt #${item.attemptIndex}`}
            >
              <div className="mono text-xs font-semibold">{item.decodeTps.toFixed(1)} tok/s</div>
              <div className="mono text-[11px] text-muted-foreground">
                E2E {item.e2eTps.toFixed(1)}
              </div>
            </div>
          );
        },
      },
    ],
    [displayCurrency, onSelectBilling],
  );

  const table = useReactTable({
    data: items,
    columns,
    getRowId: (row) => `${row.requestUid}-${row.attemptIndex}`,
    manualPagination: true,
    pageCount: Math.max(1, totalPages),
    state: {
      pagination: {
        pageIndex: Math.max(0, page - 1),
        pageSize,
      },
      columnVisibility,
    },
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex: Math.max(0, page - 1), pageSize })
          : updater;
      if (next.pageSize !== pageSize) {
        onPageSizeChange(next.pageSize);
      } else {
        onPageChange(next.pageIndex + 1);
      }
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const hasFilters = Boolean(selectedProject || selectedProvider || selectedModel || selectedStatus);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedProject || "__all__"}
            onValueChange={(val) => {
              onProjectChange(val === "__all__" ? "" : val);
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="全部项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部项目</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedProvider || "__all__"}
            onValueChange={(val) => {
              onProviderChange(val === "__all__" ? "" : val);
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="全部提供商" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部提供商</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedModel || "__all__"}
            onValueChange={(val) => {
              onModelChange(val === "__all__" ? "" : val);
            }}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="全部模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部模型</SelectItem>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedStatus || "__all__"}
            onValueChange={(val) => {
              onStatusChange(val === "__all__" ? "" : val);
            }}
          >
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部状态</SelectItem>
              <SelectItem value="success">仅成功 (&lt;400)</SelectItem>
              <SelectItem value="error">仅异常 (&gt;=400)</SelectItem>
            </SelectContent>
          </Select>

          {hasFilters ? (
            <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={onResetFilters}>
              重置
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <DataTableViewOptions table={table} columnLabels={COLUMN_LABELS} />
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  暂无匹配请求日志
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {total > 0 ? (
        <DataTablePagination
          table={table}
          pageSizeOptions={[20, 50, 100]}
          totalRows={total}
        />
      ) : null}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Copy, MoreHorizontal, Pencil } from "lucide-react";
import { toast } from "sonner";
import { LobeIcon } from "@/components/lobe-icon";
import { DataTableColumnHeader, DataTableViewOptions } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  catalogPath,
  type CatalogResource,
  type ListItems,
  type NamedItem,
} from "../types";

function EntityCell({ id, name, icon }: NamedItem & { icon?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {icon ? <LobeIcon key={icon} slug={icon} label={name || id} size={22} /> : null}
      <div className="min-w-0">
        <div className="truncate font-medium">{name || id}</div>
        <div className="mono truncate text-xs text-muted-foreground">{id}</div>
      </div>
    </div>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge variant={enabled ? "secondary" : "outline"} className="gap-1.5 font-normal">
      <span
        className={
          enabled ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-muted-foreground"
        }
      />
      {enabled ? "已启用" : "已停用"}
    </Badge>
  );
}

function ScriptChainSummary({
  scriptCount,
  derivedHooks,
}: {
  scriptCount: number;
  derivedHooks: string[];
}) {
  if (scriptCount === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium">{scriptCount} 个脚本</div>
      {derivedHooks.length > 0 ? (
        <div className="mono truncate text-[11px] text-muted-foreground">
          {derivedHooks.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

function TagsCell({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 3).map((tag) => (
        <Badge key={tag} variant="outline" className="mono px-1.5 py-0 text-[11px] font-normal">
          {tag}
        </Badge>
      ))}
      {tags.length > 3 ? (
        <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
          +{tags.length - 3}
        </Badge>
      ) : null}
    </div>
  );
}

const COLUMN_LABELS: Record<string, string> = {
  entity: "名称 / ID",
  parent: "所属上级",
  position: "顺序",
  enabled: "状态",
  models: "关联模型",
  scripts: "脚本链",
  tags: "派生标签",
};

function buildColumns<K extends CatalogResource>(
  resource: K,
  editPath: (item: ListItems[K]) => string,
  canReorder: boolean,
  onMove?: (item: ListItems[K], delta: -1 | 1) => void,
): ColumnDef<ListItems[K]>[] {
  const cols: ColumnDef<ListItems[K]>[] = [
    {
      id: "entity",
      accessorFn: (row) => `${row.name} ${row.id}`,
      header: ({ column }) => <DataTableColumnHeader column={column} title="对象" />,
      cell: ({ row }) => <EntityCell {...row.original} />,
    },
  ];

  if (resource === "provider-models") {
    cols.push({
      id: "parent",
      accessorFn: (row) =>
        "providerName" in row ? `${row.providerName} ${row.providerId}` : "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="所属提供商" />,
      cell: ({ row }) => {
        const item = row.original as ListItems["provider-models"];
        return (
          <Link
            className="text-sm text-primary hover:underline"
            to={catalogPath("providers", { edit: item.providerId })}
          >
            {item.providerName || item.providerId}
          </Link>
        );
      },
    });
  }

  if (resource === "project-models") {
    cols.push({
      id: "parent",
      accessorFn: (row) =>
        "projectName" in row ? `${row.projectName} ${row.projectId}` : "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="所属项目" />,
      cell: ({ row }) => {
        const item = row.original as ListItems["project-models"];
        return (
          <Link
            className="text-sm text-primary hover:underline"
            to={catalogPath("projects", { edit: item.projectId })}
          >
            {item.projectName || item.projectId}
          </Link>
        );
      },
    });
  }

  if (resource === "routes") {
    cols.push({
      id: "position",
      accessorKey: "position",
      header: ({ column }) => <DataTableColumnHeader column={column} title="顺序" />,
      cell: ({ row }) => <span className="mono text-xs">{row.original.position}</span>,
    });
  }

  cols.push({
    id: "enabled",
    accessorKey: "enabled",
    header: ({ column }) => <DataTableColumnHeader column={column} title="状态" />,
    cell: ({ row }) => <StatusBadge enabled={row.original.enabled} />,
  });

  if (resource === "providers" || resource === "projects") {
    cols.push({
      id: "models",
      accessorFn: (row) => ("modelCount" in row ? row.modelCount : 0),
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={resource === "providers" ? "模型数" : "调用模型数"}
        />
      ),
      cell: ({ row }) => {
        const item = row.original as ListItems["providers"];
        const target =
          resource === "providers"
            ? catalogPath("provider-models", { provider_id: item.id })
            : catalogPath("project-models", { project_id: item.id });
        return (
          <Link className="text-sm font-medium text-primary hover:underline" to={target}>
            {item.modelCount} 个模型
          </Link>
        );
      },
    });
  }

  cols.push(
    {
      id: "scripts",
      accessorKey: "scriptCount",
      header: "脚本链",
      cell: ({ row }) => (
        <ScriptChainSummary
          scriptCount={row.original.scriptCount}
          derivedHooks={row.original.derivedHooks}
        />
      ),
    },
    {
      id: "tags",
      accessorFn: (row) => row.derivedTags.join(","),
      header: "派生标签",
      cell: ({ row }) => <TagsCell tags={row.original.derivedTags} />,
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <div className="text-end">操作</div>,
      cell: ({ row, table }) => {
        const item = row.original;
        const rows = table.getRowModel().rows;
        const rowIndex = row.index;
        return (
          <div className="flex items-center justify-end gap-1">
            {canReorder && onMove ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={rowIndex === 0}
                  aria-label={`上移 ${item.name || item.id}`}
                  onClick={() => {
                    onMove(item, -1);
                  }}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={rowIndex === rows.length - 1}
                  aria-label={`下移 ${item.name || item.id}`}
                  onClick={() => {
                    onMove(item, 1);
                  }}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </>
            ) : null}

            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" asChild>
              <Link
                aria-label={`编辑 ${item.name || item.id}`}
                state="catalog-row"
                to={editPath(item)}
              >
                <Pencil className="size-3" />
                编辑
              </Link>
            </Button>

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label="更多操作">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>快捷操作</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link state="catalog-row" to={editPath(item)}>
                    <Pencil className="size-3.5" />
                    打开配置详情
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(item.id);
                    toast.success(`已复制 ID: ${item.id}`);
                  }}
                >
                  <Copy className="size-3.5" />
                  复制 ID
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  );

  return cols;
}

interface CatalogTableProps<K extends CatalogResource> {
  resource: K;
  items: ListItems[K][];
  editPath: (item: ListItems[K]) => string;
  itemKey: (item: ListItems[K]) => string;
  onMove?: (item: ListItems[K], delta: -1 | 1) => void;
  canReorder?: boolean;
  toolbarLeft?: React.ReactNode;
}

export function CatalogTable<K extends CatalogResource>({
  resource,
  items,
  editPath,
  itemKey,
  onMove,
  canReorder = false,
  toolbarLeft,
}: CatalogTableProps<K>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  const columns = useMemo(
    () => buildColumns(resource, editPath, canReorder, onMove),
    [resource, editPath, canReorder, onMove],
  );

  const table = useReactTable({
    data: items,
    columns,
    getRowId: itemKey,
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">{toolbarLeft}</div>
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
                  暂无配置记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

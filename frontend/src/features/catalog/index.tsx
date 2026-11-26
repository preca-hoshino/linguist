import { useCallback, useEffect, useState, type SubmitEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, ChevronLeft, ChevronRight, Play, Plus, RefreshCw, Search as SearchIcon, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/auth-provider";
import { useSearch } from "@/context/search-provider";
import { ConfigDrawer } from "@/components/config-drawer";
import { Header } from "@/components/layout/header";
import { Main } from "@/components/layout/main";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { Search } from "@/components/search";
import { ThemeSwitch } from "@/components/theme-switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CatalogError,
  catalogErrorMessage,
  getCatalogStatus,
  listCatalog,
  reorderCatalogItems,
} from "./api";
import {
  catalogPath,
  catalogTitles,
  useCatalogRequest,
  type CatalogResource,
  type ListItems,
  type NamedItem,
} from "./types";
import { CatalogDialog } from "./components/catalog-dialog";
import { CatalogTable } from "./components/catalog-table";

const filtersByResource: Record<CatalogResource, readonly [key: string, label: string][]> = {
  providers: [],
  "provider-models": [["provider_id", "提供商 ID"]],
  projects: [],
  "project-models": [["project_id", "项目 ID"]],
  routes: [],
};

const catalogDescriptions: Record<CatalogResource, string> = {
  providers: "配置上游模型供应商连接、加密凭据与通用请求/计价脚本。",
  "provider-models": "管理供应商下属的具体模型及其定价与能力脚本。",
  projects: "管理调用方项目、Bearer API Key 与项目级全局拦截脚本。",
  "project-models": "声明各项目对外暴露的 callModels 别名与默认映射。",
  routes: "按顺序匹配入站请求并编排多候选供应商 Fallback 路由策略。",
};

function withSearch(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function ownerId(item: NamedItem | ListItems[CatalogResource]) {
  if ("providerId" in item) return item.providerId;
  if ("projectId" in item) return item.projectId;
  return "";
}

function copyParameters(source: URLSearchParams, keys: readonly string[]) {
  const copy = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value) copy.set(key, value);
  }
  return copy;
}

interface CatalogPageProps<K extends CatalogResource> {
  resource: K;
}

export function CatalogPage<K extends CatalogResource>({ resource }: CatalogPageProps<K>) {
  const { csrfToken, handleUnauthorized } = useAuth();
  const { setDryRunOpen } = useSearch();
  const [parameters, setParameters] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);
  const [actionError, setActionError] = useState("");

  const path = catalogPath(resource);
  const filterFields = filtersByResource[resource];
  const filterKeys = ["q", ...filterFields.map(([key]) => key)];
  const filterParameters = copyParameters(parameters, filterKeys);
  const listParameters = copyParameters(parameters, [...filterKeys, "page"]);
  const filterQuery = filterParameters.toString();
  const listQuery = listParameters.toString();
  const editId = parameters.get("edit");
  const isNew = parameters.get("new") === "1";
  const owner = parameters.get("owner");

  const request = useCallback(
    (signal: AbortSignal) => listCatalog(resource, listQuery, signal),
    [listQuery, resource],
  );
  const requestStatus = useCallback((signal: AbortSignal) => getCatalogStatus(signal), []);
  const result = useCatalogRequest(request, attempt);
  const statusResult = useCatalogRequest(requestStatus, attempt);
  const status = statusResult?.data;

  useEffect(() => {
    if (
      (result?.error instanceof CatalogError && result.error.status === 401) ||
      (statusResult?.error instanceof CatalogError && statusResult.error.status === 401)
    ) {
      handleUnauthorized();
    }
  }, [result?.error, statusResult?.error, handleUnauthorized]);

  const refresh = useCallback(() => {
    setActionError("");
    setAttempt((value) => value + 1);
  }, []);

  function applyFilters(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const key of filterKeys) {
      const value = input.get(key);
      if (typeof value === "string" && value.trim()) next.set(key, value.trim());
    }
    setParameters(next);
  }

  function pagePath(page: number) {
    const next = new URLSearchParams(filterParameters);
    if (page > 1) next.set("page", String(page));
    return withSearch(path, next);
  }

  const editPath = useCallback(
    (item: ListItems[K]) => {
      const next = new URLSearchParams(listParameters);
      next.set("edit", item.id);
      const parent = ownerId(item);
      if (parent) next.set("owner", parent);
      return withSearch(path, next);
    },
    [listParameters, path],
  );

  function createPath() {
    const next = new URLSearchParams(listParameters);
    next.set("new", "1");
    return withSearch(path, next);
  }

  const scopedParentId =
    resource === "provider-models"
      ? (filterParameters.get("provider_id") ?? undefined)
      : resource === "project-models"
        ? (filterParameters.get("project_id") ?? undefined)
        : undefined;

  const canReorder =
    Boolean(result?.data) &&
    !filterParameters.get("q") &&
    result?.data?.page === 1 &&
    !result.data.hasNext &&
    (resource === "providers" ||
      resource === "projects" ||
      resource === "routes" ||
      Boolean(scopedParentId));

  const handleMove = useCallback(
    async (item: ListItems[K], delta: -1 | 1) => {
      if (!result?.data) return;
      const items = result.data.items;
      const idx = items.findIndex(
        (entry) => entry.id === item.id && ownerId(entry) === ownerId(item),
      );
      const targetIdx = idx + delta;
      if (idx < 0 || targetIdx < 0 || targetIdx >= items.length) return;
      const reordered = [...items];
      const [moved] = reordered.splice(idx, 1);
      if (!moved) return;
      reordered.splice(targetIdx, 0, moved);
      setActionError("");
      try {
        await reorderCatalogItems(
          resource,
          {
            parentId: scopedParentId ?? (ownerId(item) || undefined),
            orderedIds: reordered.map((entry) => entry.id),
            expectedRevision: result.data.revision,
          },
          csrfToken,
        );
        toast.success("已更新排序顺序");
        refresh();
      } catch (err) {
        if (err instanceof CatalogError && err.status === 401) {
          handleUnauthorized();
          return;
        }
        setActionError(catalogErrorMessage(err));
      }
    },
    [csrfToken, handleUnauthorized, refresh, resource, result?.data, scopedParentId],
  );

  const detailParameters = new URLSearchParams();
  if (editId) detailParameters.set("id", editId);
  if (resource === "provider-models" && (owner ?? parameters.get("provider_id"))) {
    detailParameters.set("provider_id", owner ?? parameters.get("provider_id") ?? "");
  }
  if (resource === "project-models" && (owner ?? parameters.get("project_id"))) {
    detailParameters.set("project_id", owner ?? parameters.get("project_id") ?? "");
  }
  const detailQuery = detailParameters.toString();
  const title = catalogTitles[resource];
  const revisionMismatch = Boolean(status && status.revision !== status.loadedRevision);

  const filterToolbar = (
    <form
      key={filterQuery}
      className="flex flex-wrap items-center gap-2"
      role="search"
      onSubmit={applyFilters}
    >
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute start-2.5 top-2 size-3.5 text-muted-foreground" />
        <Input
          className="h-8 w-48 ps-8 lg:w-64"
          type="search"
          name="q"
          aria-label="搜索名称或 ID"
          placeholder="搜索名称或 ID…"
          autoComplete="off"
          maxLength={200}
          defaultValue={filterParameters.get("q") ?? ""}
        />
      </div>
      {filterFields.map(([key, label]) => (
        <Input
          key={key}
          className="mono h-8 w-40"
          name={key}
          aria-label={label}
          placeholder={`${label}…`}
          autoComplete="off"
          spellCheck={false}
          defaultValue={filterParameters.get(key) ?? ""}
        />
      ))}
      <Button variant="secondary" size="sm" type="submit" className="h-8">
        搜索
      </Button>
      {filterQuery ? (
        <Button variant="ghost" size="sm" className="h-8 gap-1" asChild>
          <Link to={path}>
            清除
            <X className="size-3.5" />
          </Link>
        </Button>
      ) : null}
    </form>
  );

  return (
    <>
      <Header fixed>
        <Search className="me-auto" />
        <div className="flex items-center gap-2">
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main className="flex flex-1 flex-col gap-4 sm:gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{catalogDescriptions[resource]}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setDryRunOpen(true);
              }}
            >
              <Play className="size-3.5" />
              Dry-Run 演练
            </Button>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={refresh}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button size="sm" className="gap-1.5" asChild>
              <Link to={createPath()}>
                <Plus className="size-4" />
                新建{title}
              </Link>
            </Button>
          </div>
        </div>

        {result?.data && revisionMismatch && status ? (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>配置版本同步中</AlertTitle>
            <AlertDescription className="mono text-xs">
              PostgreSQL 版本 r{status.revision} · 当前网关实例已加载 r{status.loadedRevision}
            </AlertDescription>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert variant="destructive">
            <AlertTitle>操作失败</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        {!result ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !result.data ? (
          <Alert variant="destructive">
            <AlertTitle>加载列表失败</AlertTitle>
            <AlertDescription>{catalogErrorMessage(result.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <CatalogTable
              resource={resource}
              items={result.data.items}
              editPath={editPath}
              itemKey={(item) => JSON.stringify([ownerId(item), item.id])}
              canReorder={canReorder}
              onMove={(item, delta) => {
                void handleMove(item, delta);
              }}
              toolbarLeft={filterToolbar}
            />

            {result.data.page > 1 || result.data.hasNext ? (
              <nav className="flex items-center justify-end gap-2" aria-label="分页">
                {result.data.page > 1 ? (
                  <Button variant="outline" size="sm" className="gap-1" asChild>
                    <Link to={pagePath(result.data.page - 1)}>
                      <ChevronLeft className="size-4" />
                      上一页
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="gap-1" disabled>
                    <ChevronLeft className="size-4" />
                    上一页
                  </Button>
                )}
                <span className="px-2 text-sm text-muted-foreground">
                  第 {result.data.page} 页
                </span>
                {result.data.hasNext ? (
                  <Button variant="outline" size="sm" className="gap-1" asChild>
                    <Link to={pagePath(result.data.page + 1)}>
                      下一页
                      <ChevronRight className="size-4" />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="gap-1" disabled>
                    下一页
                    <ChevronRight className="size-4" />
                  </Button>
                )}
              </nav>
            ) : null}
          </div>
        )}
      </Main>

      {(editId || isNew) && result?.data ? (
        <CatalogDialog
          key={isNew ? `new:${resource}` : detailQuery}
          resource={resource}
          mode={isNew ? "create" : "edit"}
          query={detailQuery}
          defaultParentId={scopedParentId}
          currentRevision={result.data.revision}
          onSaved={refresh}
          onClose={() => {
            if (location.state === "catalog-row") {
              void navigate(-1);
            } else {
              void navigate(withSearch(path, listParameters), { replace: true });
            }
          }}
        />
      ) : null}
    </>
  );
}

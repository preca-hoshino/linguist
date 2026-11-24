import { useCallback, useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { CatalogError, catalogErrorMessage, getCatalogStatus, listCatalog } from "./api";
import { CatalogDialog } from "./CatalogDialog";
import { CatalogTable } from "./CatalogTable";
import { catalogPath, catalogTitles } from "./navigation";
import type { CatalogResource, ListItems, NamedItem } from "./types";
import { useCatalogRequest } from "./useCatalogRequest";
import { PriceDialog } from "../billing/PriceDialog";

const filtersByResource: Record<CatalogResource, readonly [key: string, label: string][]> = {
  providers: [],
  "provider-models": [["provider_id", "提供商 ID"]],
  projects: [],
  "project-models": [["project_id", "项目 ID"]],
  routes: [["project_id", "项目 ID"], ["call_model_id", "调用模型 ID"]],
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

function isFirstMatch(item: ListItems[CatalogResource]) {
  return "firstMatch" in item && item.firstMatch;
}

interface CatalogPageProps<K extends CatalogResource> {
  resource: K;
}

export function CatalogPage<K extends CatalogResource>({ resource }: CatalogPageProps<K>) {
  const { handleUnauthorized } = useAuth();
  const [parameters, setParameters] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);
  const [priceTarget, setPriceTarget] = useState<{ providerId: string; modelId: string; name: string } | null>(null);
  const path = catalogPath(resource);
  const filterFields = filtersByResource[resource];
  const filterKeys = ["q", ...filterFields.map(([key]) => key)];
  const filterParameters = copyParameters(parameters, filterKeys);
  const listParameters = copyParameters(parameters, [...filterKeys, "page"]);
  const filterQuery = filterParameters.toString();
  const listQuery = listParameters.toString();
  const editId = parameters.get("edit");
  const owner = parameters.get("owner");

  const request = useCallback((signal: AbortSignal) => listCatalog(resource, listQuery, signal), [listQuery, resource]);
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

  function refresh() {
    setAttempt((value) => value + 1);
  }

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

  function editPath(item: ListItems[K]) {
    const next = new URLSearchParams(listParameters);
    next.set("edit", item.id);
    const parent = ownerId(item);
    if (parent) next.set("owner", parent);
    return withSearch(path, next);
  }

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
  const revisionMismatch = status && status.revision !== status.loadedRevision;

  return (
    <>
      <header className="header-bar">
        <div className="header-inner">
          <div className="brand-group">
            <div className="brand-mark" aria-hidden="true">LG</div>
            <h1 className="brand-title">{title}</h1>
          </div>
          <button type="button" className="btn-control" onClick={refresh}>立即刷新</button>
        </div>
      </header>
      <main className="page-container" id="main-content" tabIndex={-1}>
        {result?.data && (status?.syncError || revisionMismatch) ? (
          <div className="error-banner" role="status">
            {status.syncError ? `JSON 同步失败 · 当前 r${status.revision}` : `PG r${status.revision} · 当前实例 r${status.loadedRevision}`}
          </div>
        ) : null}
        <section className="section-card catalog-card" aria-label={title}>
          <form key={filterQuery} className="catalog-controls" role="search" onSubmit={applyFilters}>
            <input className="select-control catalog-search" type="search" name="q" aria-label="搜索名称或 ID"
              placeholder="搜索名称或 ID…" autoComplete="off" maxLength={200} defaultValue={filterParameters.get("q") ?? ""} />
            {filterFields.map(([key, label]) => (
              <input key={key} className="select-control catalog-filter" name={key} aria-label={label}
                placeholder={`${label}…`} autoComplete="off" spellCheck={false} defaultValue={filterParameters.get(key) ?? ""} />
            ))}
            <button className="btn-control" type="submit">搜索</button>
            {filterQuery ? <Link className="btn-control catalog-link-button" to={path}>清除</Link> : null}
          </form>
          {!result ? <p className="empty-state" role="status">加载中…</p> : null}
          {result && !result.data ? <div className="error-banner catalog-error" role="alert">{catalogErrorMessage(result.error)}</div> : null}
          {result?.data ? (
            <>
              {result.data.items.length ? (
                <CatalogTable resource={resource} items={result.data.items}
                  editPath={editPath} itemKey={(item) => JSON.stringify([ownerId(item), item.id])} activeRow={isFirstMatch}
                  onPrice={resource === "provider-models" ? (item) => { if ("providerId" in item) setPriceTarget({ providerId: item.providerId, modelId: item.id, name: item.name }); } : undefined} />
              ) : (
                <p className="empty-state" role="status">
                  {result.data.revision === 0 ? "尚未导入配置" : filterQuery || result.data.page > 1 ? "未找到匹配项" : `暂无${title}`}
                </p>
              )}
              {result.data.page > 1 || result.data.hasNext ? (
                <nav className="catalog-pagination" aria-label="分页">
                  {result.data.page > 1 ? <Link className="btn-control catalog-link-button" to={pagePath(result.data.page - 1)}>上一页</Link> : <button className="btn-control" disabled>上一页</button>}
                  <span>第 {result.data.page} 页</span>
                  {result.data.hasNext ? <Link className="btn-control catalog-link-button" to={pagePath(result.data.page + 1)}>下一页</Link> : <button className="btn-control" disabled>下一页</button>}
                </nav>
              ) : null}
            </>
          ) : null}
        </section>
      </main>
      {editId && result?.data ? (
        <CatalogDialog key={detailQuery} resource={resource} query={detailQuery} onClose={() => {
          if (location.state === "catalog-row") void navigate(-1);
          else void navigate(withSearch(path, listParameters), { replace: true });
        }} />
      ) : null}
      {priceTarget ? <PriceDialog {...priceTarget} onClose={() => { setPriceTarget(null); }} onSaved={refresh} /> : null}
    </>
  );
}

function copyParameters(source: URLSearchParams, keys: readonly string[]) {
  const copy = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value) copy.set(key, value);
  }
  return copy;
}

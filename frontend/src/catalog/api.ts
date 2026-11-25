import type {
  CatalogDetails,
  CatalogPageData,
  CatalogResource,
  CatalogStatus,
  DryRunResult,
  ScriptItem,
  ValidateScriptsResult,
} from "./types";

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code ?? "error"}: ${detail}` : `Catalog request failed: HTTP ${status}`);
  }
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/catalog/${path}`, {
    ...init,
    credentials: "same-origin",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : undefined;
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message
        : undefined;
    throw new CatalogError(response.status, code, message);
  }
  return body as T;
}

export function listCatalog<T extends CatalogResource>(
  resource: T,
  search: string,
  signal: AbortSignal,
) {
  return requestJson<CatalogPageData<T>>(`${resource}?${search}`, { signal });
}

export function getCatalogDetails<T extends CatalogResource>(
  resource: T,
  search: string,
  signal: AbortSignal,
) {
  return requestJson<CatalogDetails<T>>(`${resource}/detail?${search}`, { signal });
}

export function getCatalogStatus(signal: AbortSignal) {
  return requestJson<CatalogStatus>("status", { signal });
}

export function createCatalogItem(
  resource: CatalogResource,
  payload: Record<string, unknown>,
  csrfToken: string,
) {
  return requestJson<{ ok: boolean; revision: number }>(resource, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
  });
}

export function updateCatalogItem(
  resource: CatalogResource,
  payload: Record<string, unknown>,
  csrfToken: string,
) {
  return requestJson<{ ok: boolean; revision: number }>(resource, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
  });
}

export function deleteCatalogItem(
  resource: CatalogResource,
  query: string,
  csrfToken: string,
) {
  return requestJson<{ ok: boolean; revision: number }>(`${resource}?${query}`, {
    method: "DELETE",
    headers: {
      "X-CSRF-Token": csrfToken,
    },
  });
}

export function reorderCatalogItems(
  resource: CatalogResource,
  payload: { parentId?: string; orderedIds: string[]; expectedRevision?: number },
  csrfToken: string,
) {
  return requestJson<{ ok: boolean; revision: number }>(`${resource}/reorder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
  });
}

export function validateScripts(scripts: ScriptItem[], csrfToken: string) {
  return requestJson<ValidateScriptsResult>("scripts/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ scripts }),
  });
}

export function dryRunCatalog(
  payload: { projectId: string; model: string; stream: boolean },
  csrfToken: string,
) {
  return requestJson<DryRunResult>("dry-run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
  });
}

export function catalogErrorMessage(error: unknown) {
  if (error instanceof CatalogError) {
    if (error.detail) return error.detail;
    if (error.code === "revision_conflict") return "配置已被其他会话修改，请刷新后重试";
    if (error.code === "has_children") return "请先删除下属子模型后再删除该项";
    if (error.code === "csrf_mismatch") return "CSRF 校验失败，请刷新页面";
    if (error.code === "catalog_disabled") return "目录服务不可用";
    if (error.status === 401) return "登录已失效，请重新登录";
    if (error.status === 404) return "配置项不存在";
    if (error.status === 503) return "PostgreSQL 暂不可用";
    if (error.status === 400) return "请求参数或脚本无效";
  }
  return "操作失败";
}

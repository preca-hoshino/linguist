import type { CatalogDetails, CatalogPageData, CatalogResource, CatalogStatus } from "./types";

export class CatalogError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Catalog request failed: HTTP ${status}`);
  }
}

async function read<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/catalog/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error : undefined;
    throw new CatalogError(response.status, code);
  }
  return (await response.json()) as T;
}

export function listCatalog<T extends CatalogResource>(resource: T, search: string, token: string, signal: AbortSignal) {
  return read<CatalogPageData<T>>(`${resource}?${search}`, token, signal);
}

export function getCatalogDetails<T extends CatalogResource>(resource: T, search: string, token: string, signal: AbortSignal) {
  return read<CatalogDetails<T>>(`${resource}/detail?${search}`, token, signal);
}

export function getCatalogStatus(token: string, signal: AbortSignal) {
  return read<CatalogStatus>("status", token, signal);
}

export function catalogErrorMessage(error: unknown) {
  if (error instanceof CatalogError) {
    if (error.code === "catalog_disabled") return "未配置目录访问令牌";
    if (error.status === 401) return "令牌无效";
    if (error.status === 404) return "配置项不存在";
    if (error.status === 503) return "PostgreSQL 暂不可用";
    if (error.status === 400) return "筛选参数无效";
  }
  return "配置加载失败";
}

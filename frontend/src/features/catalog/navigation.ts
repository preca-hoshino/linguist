import type { CatalogResource } from "./types";

export const catalogTitles: Record<CatalogResource, string> = {
  providers: "提供商",
  "provider-models": "提供商模型",
  projects: "项目",
  "project-models": "项目调用模型",
  routes: "路由规则",
};

export function catalogPath(resource: CatalogResource, filters: Record<string, string> = {}) {
  const search = new URLSearchParams(filters).toString();
  return `/${resource}${search ? `?${search}` : ""}`;
}

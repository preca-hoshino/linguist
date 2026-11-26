export type CatalogResource =
  | "providers"
  | "provider-models"
  | "projects"
  | "project-models"
  | "routes";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface NamedItem {
  id: string;
  name: string;
}

export interface ScriptItem {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
}

interface CatalogBaseItem extends NamedItem {
  icon: string;
  enabled: boolean;
  position: number;
  scriptCount: number;
  derivedTags: string[];
  derivedMeta: JsonObject;
  derivedHooks: string[];
}

export interface ParentItem extends CatalogBaseItem {
  modelCount: number;
}

export interface ProviderModel extends CatalogBaseItem {
  providerId: string;
  providerName: string;
}

export interface ProjectModel extends CatalogBaseItem {
  projectId: string;
  projectName: string;
}

export type CatalogRoute = CatalogBaseItem;

export interface ListItems {
  providers: ParentItem;
  "provider-models": ProviderModel;
  projects: ParentItem;
  "project-models": ProjectModel;
  routes: CatalogRoute;
}

export interface DetailItems {
  providers: ParentItem & {
    hasApiKey: boolean;
    models: NamedItem[];
    scripts: ScriptItem[];
  };
  "provider-models": ProviderModel & {
    scripts: ScriptItem[];
  };
  projects: ParentItem & {
    apiKey: string;
    callModels: NamedItem[];
    scripts: ScriptItem[];
  };
  "project-models": ProjectModel & {
    scripts: ScriptItem[];
  };
  routes: CatalogRoute & {
    scripts: ScriptItem[];
  };
}

export interface CatalogDetails<T extends CatalogResource> {
  revision: number;
  item: DetailItems[T];
}

export interface CatalogPageData<T extends CatalogResource> {
  items: ListItems[T][];
  page: number;
  pageSize: number;
  hasNext: boolean;
  revision: number;
}

export interface CatalogStatus {
  revision: number;
  loadedRevision: number;
  updatedAt: string | null;
  writeMode: "postgres";
  syncError: string | null;
}

export interface ValidateScriptsResult {
  ok: boolean;
  tags?: string[];
  meta?: JsonObject;
  hooks?: string[];
  error?: string;
  message?: string;
}

export interface DryRunCandidate {
  providerId: string;
  modelId: string;
  status: string;
  url?: string;
  body?: JsonObject;
  state?: JsonObject;
  statusCode?: number;
  message?: string;
  error?: string;
}

export interface DryRunResult {
  status: "ready" | "rejected";
  routeRuleId?: string | null;
  statusCode?: number;
  message?: string;
  candidates?: DryRunCandidate[];
}

export { catalogPath, catalogTitles } from "./navigation";
export { useCatalogRequest } from "./use-catalog-request";

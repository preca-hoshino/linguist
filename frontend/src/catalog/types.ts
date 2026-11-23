export type CatalogResource = "providers" | "provider-models" | "projects" | "project-models" | "routes";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface NamedItem {
  id: string;
  name: string;
}

interface IconItem extends NamedItem {
  icon: string;
}

export interface ParentItem extends IconItem {
  modelCount: number;
}

export interface ProviderModel extends IconItem {
  providerId: string;
  providerName: string;
  hasPrice: boolean;
  toolCalling: boolean | null;
  vision: boolean | null;
  thinking: boolean | null;
  streaming: boolean | null;
  supportsReasoningEffort: string[] | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export interface ProjectModel extends IconItem {
  projectId: string;
  projectName: string;
}

export interface RouteTarget {
  providerId: string;
  modelId: string;
  maxAttempts: number;
}

export interface CatalogRoute extends NamedItem {
  enabled: boolean;
  priority: number;
  match: { projectIds: string[]; callModelIds: string[] };
  candidates: { allow: string[]; deny: string[] };
  target: RouteTarget | null;
  fallbacks: RouteTarget[];
  rewriteResponseModel: boolean;
  hasScript: boolean;
  firstMatch: boolean;
}

export interface ListItems {
  providers: ParentItem;
  "provider-models": ProviderModel;
  projects: ParentItem;
  "project-models": ProjectModel;
  routes: CatalogRoute;
}

export interface DetailItems {
  providers: ParentItem & {
    vendor: string | null;
    apiType: string | null;
    hasApiKey: boolean;
    models: NamedItem[];
  };
  "provider-models": ProviderModel & { url: string | null };
  projects: ParentItem & { hasApiKey: boolean; meta: JsonObject; callModels: NamedItem[] };
  "project-models": ProjectModel & { meta: JsonObject };
  routes: CatalogRoute;
}

export interface CatalogDetails<T extends CatalogResource> {
  revision: number;
  item: DetailItems[T] & { script: string | null };
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
  writeMode: "json_sync" | "postgres";
  syncError: string | null;
}

import type { ReactNode } from "react";
import { Link } from "react-router";
import { LobeIcon } from "../components/LobeIcon";
import { catalogPath } from "./navigation";
import type { CatalogResource, ListItems, NamedItem } from "./types";

export interface Column<T> {
  title: string;
  render: (item: T) => ReactNode;
}

function Entity({ id, name, icon }: NamedItem & { icon?: string }) {
  return (
    <div className="entity-cell">
      {icon ? (
        <span aria-hidden="true">
          <LobeIcon key={icon} slug={icon} label={name} size={24} />
        </span>
      ) : null}
      <div className="catalog-entity-text">
        <strong>{name || id}</strong>
        <span className="mono">{id}</span>
      </div>
    </div>
  );
}

function ScriptChainSummary({
  scriptCount,
  derivedHooks,
}: {
  scriptCount: number;
  derivedHooks: string[];
}) {
  if (scriptCount === 0) return <span>—</span>;
  return (
    <div className="catalog-route-scope">
      <span>{scriptCount} 个脚本</span>
      {derivedHooks.length > 0 ? (
        <span className="mono" style={{ fontSize: 11 }}>
          {derivedHooks.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function TagsCell({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span>—</span>;
  return (
    <div className="token-pills">
      {tags.slice(0, 4).map((tag) => (
        <span key={tag} className="token-pill mono">
          {tag}
        </span>
      ))}
      {tags.length > 4 ? <span className="token-pill">+{tags.length - 4}</span> : null}
    </div>
  );
}

const catalogColumns: { [K in CatalogResource]: readonly Column<ListItems[K]>[] } = {
  providers: [
    { title: "提供商", render: (item) => <Entity {...item} /> },
    { title: "状态", render: (item) => (item.enabled ? "已启用" : "已停用") },
    {
      title: "模型数",
      render: (item) => (
        <Link className="catalog-link" to={catalogPath("provider-models", { provider_id: item.id })}>
          {item.modelCount} 个模型
        </Link>
      ),
    },
    {
      title: "脚本链",
      render: (item) => (
        <ScriptChainSummary scriptCount={item.scriptCount} derivedHooks={item.derivedHooks} />
      ),
    },
    { title: "派生标签", render: (item) => <TagsCell tags={item.derivedTags} /> },
  ],
  "provider-models": [
    { title: "模型", render: (item) => <Entity {...item} /> },
    {
      title: "所属提供商",
      render: (item) => (
        <Link className="catalog-link" to={catalogPath("providers", { edit: item.providerId })}>
          {item.providerName || item.providerId}
        </Link>
      ),
    },
    { title: "状态", render: (item) => (item.enabled ? "已启用" : "已停用") },
    {
      title: "脚本链",
      render: (item) => (
        <ScriptChainSummary scriptCount={item.scriptCount} derivedHooks={item.derivedHooks} />
      ),
    },
    { title: "派生标签", render: (item) => <TagsCell tags={item.derivedTags} /> },
  ],
  projects: [
    { title: "项目", render: (item) => <Entity {...item} /> },
    { title: "状态", render: (item) => (item.enabled ? "已启用" : "已停用") },
    {
      title: "调用模型数",
      render: (item) => (
        <Link className="catalog-link" to={catalogPath("project-models", { project_id: item.id })}>
          {item.modelCount} 个模型
        </Link>
      ),
    },
    {
      title: "脚本链",
      render: (item) => (
        <ScriptChainSummary scriptCount={item.scriptCount} derivedHooks={item.derivedHooks} />
      ),
    },
    { title: "派生标签", render: (item) => <TagsCell tags={item.derivedTags} /> },
  ],
  "project-models": [
    { title: "调用模型", render: (item) => <Entity {...item} /> },
    {
      title: "所属项目",
      render: (item) => (
        <Link className="catalog-link" to={catalogPath("projects", { edit: item.projectId })}>
          {item.projectName || item.projectId}
        </Link>
      ),
    },
    { title: "状态", render: (item) => (item.enabled ? "已启用" : "已停用") },
    {
      title: "脚本链",
      render: (item) => (
        <ScriptChainSummary scriptCount={item.scriptCount} derivedHooks={item.derivedHooks} />
      ),
    },
    { title: "派生标签", render: (item) => <TagsCell tags={item.derivedTags} /> },
  ],
  routes: [
    { title: "规则", render: (item) => <Entity {...item} /> },
    { title: "顺序", render: (item) => <span className="mono">{item.position}</span> },
    { title: "状态", render: (item) => (item.enabled ? "已启用" : "已停用") },
    {
      title: "脚本链",
      render: (item) => (
        <ScriptChainSummary scriptCount={item.scriptCount} derivedHooks={item.derivedHooks} />
      ),
    },
    { title: "派生标签", render: (item) => <TagsCell tags={item.derivedTags} /> },
  ],
};

interface CatalogTableProps<K extends CatalogResource> {
  resource: K;
  items: ListItems[K][];
  editPath: (item: ListItems[K]) => string;
  itemKey: (item: ListItems[K]) => string;
  onMove?: (item: ListItems[K], delta: -1 | 1) => void;
  canReorder?: boolean;
}

export function CatalogTable<K extends CatalogResource>({
  resource,
  items,
  editPath,
  itemKey,
  onMove,
  canReorder = false,
}: CatalogTableProps<K>) {
  const columns = catalogColumns[resource];
  return (
    <div className="table-scroll catalog-table-scroll" tabIndex={0} role="region" aria-label="配置列表">
      <table className="requests-table catalog-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.title} scope="col">
                {column.title}
              </th>
            ))}
            <th scope="col" className="catalog-action">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr key={itemKey(item)}>
              {columns.map((column) => (
                <td key={column.title}>{column.render(item)}</td>
              ))}
              <td className="catalog-action">
                {canReorder && onMove ? (
                  <>
                    <button
                      type="button"
                      className="catalog-link billing-link-button"
                      disabled={idx === 0}
                      aria-label={`上移 ${item.name || item.id}`}
                      onClick={() => {
                        onMove(item, -1);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="catalog-link billing-link-button"
                      disabled={idx === items.length - 1}
                      aria-label={`下移 ${item.name || item.id}`}
                      onClick={() => {
                        onMove(item, 1);
                      }}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
                <Link
                  className="catalog-link"
                  aria-label={`编辑 ${item.name || item.id}`}
                  state="catalog-row"
                  to={editPath(item)}
                >
                  编辑
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

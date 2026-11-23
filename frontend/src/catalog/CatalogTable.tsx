import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatTokens } from "../api/client";
import { LobeIcon } from "../components/LobeIcon";
import { catalogPath } from "./navigation";
import type { CatalogResource, ListItems, NamedItem, RouteTarget } from "./types";

export interface Column<T> {
  title: string;
  render: (item: T) => ReactNode;
}

function Entity({ id, name, icon }: NamedItem & { icon?: string }) {
  return (
    <div className="entity-cell">
      {icon ? <span aria-hidden="true"><LobeIcon key={icon} slug={icon} label={name} size={24} /></span> : null}
      <div className="catalog-entity-text">
        <strong>{name || id}</strong>
        <span className="mono">{id}</span>
      </div>
    </div>
  );
}

function TargetLink({ target }: { target: RouteTarget }) {
  return (
    <Link className="catalog-link mono" to={catalogPath("provider-models", {
      provider_id: target.providerId, edit: target.modelId, owner: target.providerId,
    })}>
      {target.providerId} / {target.modelId}
    </Link>
  );
}

const catalogColumns: { [K in CatalogResource]: readonly Column<ListItems[K]>[] } = {
  providers: [
    { title: "提供商", render: (item) => <Entity {...item} /> },
    { title: "模型数", render: (item) => (
      <Link className="catalog-link" to={catalogPath("provider-models", { provider_id: item.id })}>{item.modelCount} 个模型</Link>
    ) },
  ],
  "provider-models": [
    { title: "模型", render: (item) => <Entity {...item} /> },
    { title: "所属提供商", render: (item) => (
      <Link className="catalog-link" to={catalogPath("providers", { edit: item.providerId })}>{item.providerName || item.providerId}</Link>
    ) },
    { title: "能力", render: (item) => {
      const capabilities = [
        item.toolCalling ? "工具调用" : null, item.vision ? "视觉" : null,
        item.thinking || item.supportsReasoningEffort?.length ? "推理" : null, item.streaming ? "流式" : null,
      ].filter(Boolean);
      return capabilities.length ? capabilities.join(" · ") : "—";
    } },
    { title: "输入 / 输出上限", render: (item) => (
      <span className="mono catalog-nowrap">
        {item.maxInputTokens === null ? "—" : formatTokens(item.maxInputTokens)} / {item.maxOutputTokens === null ? "—" : formatTokens(item.maxOutputTokens)}
      </span>
    ) },
    { title: "价格", render: (item) => item.hasPrice ? "已配置" : "未配置" },
  ],
  projects: [
    { title: "项目", render: (item) => <Entity {...item} /> },
    { title: "调用模型数", render: (item) => (
      <Link className="catalog-link" to={catalogPath("project-models", { project_id: item.id })}>{item.modelCount} 个模型</Link>
    ) },
  ],
  "project-models": [
    { title: "调用模型", render: (item) => <Entity {...item} /> },
    { title: "所属项目", render: (item) => (
      <Link className="catalog-link" to={catalogPath("projects", { edit: item.projectId })}>{item.projectName || item.projectId}</Link>
    ) },
    { title: "路由规则", render: (item) => (
      <Link className="catalog-link catalog-nowrap" to={catalogPath("routes", { project_id: item.projectId, call_model_id: item.id })}>查看匹配规则</Link>
    ) },
  ],
  routes: [
    { title: "规则", render: (item) => <Entity {...item} /> },
    { title: "优先级", render: (item) => <span className="mono">{item.priority}</span> },
    { title: "状态", render: (item) => item.firstMatch ? <strong className="catalog-first-match">首条命中</strong> : item.enabled ? "已启用" : "已停用" },
    { title: "匹配范围", render: ({ match }) => (
      <div className="catalog-route-scope">
        <span>项目：{match.projectIds.join("、") || "—"}</span>
        <span>模型：{match.callModelIds.join("、") || "—"}</span>
      </div>
    ) },
    { title: "候选约束", render: ({ candidates }) => {
      const allowAll = candidates.allow.length === 0 || candidates.allow.some((pattern) => pattern.trim() === "*");
      return (
        <div className="catalog-route-scope catalog-nowrap">
          <span>{allowAll ? "允许全部" : `允许 ${candidates.allow.length} 项`}</span>
          {candidates.deny.length ? <span>排除 {candidates.deny.length} 项</span> : null}
        </div>
      );
    } },
    { title: "默认目标", render: (item) => item.target ? <TargetLink target={item.target} /> : "—" },
    { title: "回退", render: (item) => item.fallbacks.length ? `${item.fallbacks.length} 个` : "—" },
    { title: "脚本", render: (item) => item.hasScript ? "有" : "—" },
  ],
};

interface CatalogTableProps<K extends CatalogResource> {
  resource: K;
  items: ListItems[K][];
  editPath: (item: ListItems[K]) => string;
  itemKey: (item: ListItems[K]) => string;
  activeRow?: (item: ListItems[K]) => boolean;
  onPrice?: (item: ListItems[K]) => void;
}

export function CatalogTable<K extends CatalogResource>({ resource, items, editPath, itemKey, activeRow, onPrice }: CatalogTableProps<K>) {
  const columns = catalogColumns[resource];
  return (
    <div className="table-scroll catalog-table-scroll" tabIndex={0} role="region" aria-label="配置列表">
      <table className="requests-table catalog-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.title} scope="col">{column.title}</th>)}
            <th scope="col" className="catalog-action">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={itemKey(item)} className={activeRow?.(item) ? "catalog-row-active" : undefined}>
              {columns.map((column) => <td key={column.title}>{column.render(item)}</td>)}
              <td className="catalog-action">{onPrice ? <button type="button" className="catalog-link billing-link-button" onClick={() => { onPrice(item); }}>价格</button> : null}<Link className="catalog-link" aria-label={`编辑 ${item.name || item.id}`} state="catalog-row" to={editPath(item)}>编辑</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

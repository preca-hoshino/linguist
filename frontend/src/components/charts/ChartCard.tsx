import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  description: string;
  controls?: ReactNode;
  empty?: boolean;
  emptyText?: string;
  loading?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
}

export function ChartCard({
  title,
  description,
  controls,
  empty = false,
  emptyText = "当前筛选条件下暂无数据",
  loading = false,
  fullWidth = false,
  children,
}: ChartCardProps) {
  return (
    <section className={`section-card monitoring-card${fullWidth ? " monitoring-card-full" : ""}`}>
      <div className="section-header">
        <div>
          <h2 className="section-title">{title}</h2>
          <p className="section-desc">{description}</p>
        </div>
        {controls ? <div className="filter-pills">{controls}</div> : null}
      </div>

      {loading ? (
        <div className="monitoring-empty" role="status">正在加载图表数据…</div>
      ) : empty ? (
        <div className="monitoring-empty">{emptyText}</div>
      ) : (
        children
      )}
    </section>
  );
}

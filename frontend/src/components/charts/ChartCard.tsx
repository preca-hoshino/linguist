import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  description?: string;
  helpText?: string;
  controls?: ReactNode;
  empty?: boolean;
  emptyText?: string;
  loading?: boolean;
  fullWidth?: boolean;
  span?: 1 | 2 | 3;
  expandable?: boolean;
  children: ReactNode;
}

export function ChartCard({
  title,
  description,
  helpText,
  controls,
  empty = false,
  emptyText = "当前筛选条件下暂无数据",
  loading = false,
  fullWidth = false,
  span,
  expandable = true,
  children,
}: ChartCardProps) {
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (expanded && !dlg.open) {
      dlg.showModal();
    } else if (!expanded && dlg.open) {
      dlg.close();
    }
  }, [expanded]);

  const spanClass = fullWidth || span === 3
    ? " monitoring-card-full"
    : span === 2
      ? " monitoring-card-span2"
      : "";

  const tip = helpText ?? description;

  return (
    <section className={`section-card monitoring-card${spanClass}`}>
      <div className="section-header">
        <div className="monitoring-card-title-block">
          <div className="monitoring-card-title-row">
            <h3 className="section-title">{title}</h3>
            {tip ? (
              <span className="monitoring-help-tip" title={tip} aria-label={tip}>
                ?
              </span>
            ) : null}
          </div>
          {description ? <p className="section-desc">{description}</p> : null}
        </div>
        <div className="filter-pills">
          {controls}
          {expandable && !loading && !empty ? (
            <button
              type="button"
              className="monitoring-icon-btn"
              title="放大查看"
              aria-label={`放大查看 ${title}`}
              onClick={() => { setExpanded(true); }}
            >
              ⛶
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="monitoring-empty" role="status">正在加载图表数据…</div>
      ) : empty ? (
        <div className="monitoring-empty">{emptyText}</div>
      ) : (
        children
      )}

      {expanded ? (
        <dialog
          ref={dialogRef}
          className="catalog-dialog monitoring-zoom-dialog"
          aria-label={title}
          onClose={() => { setExpanded(false); }}
          onClick={(e) => {
            if (e.target === dialogRef.current) setExpanded(false);
          }}
        >
          <div className="catalog-dialog-header">
            <div>
              <h2>{title}</h2>
              {tip ? <span className="catalog-dialog-name">{tip}</span> : null}
            </div>
            <button
              type="button"
              className="btn-control"
              onClick={() => { setExpanded(false); }}
            >
              关闭
            </button>
          </div>
          <div className="catalog-dialog-body">
            {children}
          </div>
        </dialog>
      ) : null}
    </section>
  );
}

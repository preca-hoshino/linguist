import { useState } from "react";
import type { ReactNode } from "react";

interface SectionGroupProps {
  title: string;
  subtitle?: string;
  controls?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function SectionGroup({
  title,
  subtitle,
  controls,
  defaultOpen = true,
  children,
}: SectionGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="monitoring-section-group">
      <div className="monitoring-section-bar">
        <button
          type="button"
          className="monitoring-section-toggle"
          aria-expanded={open}
          onClick={() => { setOpen((prev) => !prev); }}
        >
          <span className="monitoring-section-arrow" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="monitoring-section-title">{title}</span>
          {subtitle ? <span className="monitoring-section-sub">{subtitle}</span> : null}
        </button>
        {open && controls ? <div className="filter-pills">{controls}</div> : null}
      </div>
      {open ? <div className="monitoring-grid">{children}</div> : null}
    </div>
  );
}

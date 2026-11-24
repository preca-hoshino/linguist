export interface HorizontalBarItem {
  key: string;
  label: string;
  value: number;
  subLabel?: string;
  color: string;
}

interface HorizontalBarChartProps {
  items: HorizontalBarItem[];
  formatValue?: (v: number) => string;
}

export function HorizontalBarChart({
  items,
  formatValue = (v) => v.toFixed(2),
}: HorizontalBarChartProps) {
  const maxVal = items.reduce((m, item) => Math.max(m, item.value), 0) || 1;

  return (
    <div className="monitoring-hbar-list">
      {items.map((item) => {
        const pct = Math.max(2, (item.value / maxVal) * 100);
        return (
          <div key={item.key} className="monitoring-hbar-row">
            <div className="monitoring-hbar-head">
              <span className="monitoring-hbar-label" title={item.label}>{item.label}</span>
              <span className="mono monitoring-hbar-value">
                {formatValue(item.value)}
                {item.subLabel ? <span className="monitoring-hbar-sub"> · {item.subLabel}</span> : null}
              </span>
            </div>
            <div className="speed-bar-track">
              <div
                className="speed-bar-fill"
                style={{ width: `${pct.toFixed(1)}%`, backgroundColor: item.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

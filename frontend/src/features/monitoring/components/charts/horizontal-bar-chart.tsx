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
    <div className="space-y-3">
      {items.map((item) => {
        const pct = Math.max(2, (item.value / maxVal) * 100);
        return (
          <div key={item.key} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-medium" title={item.label}>
                {item.label}
              </span>
              <span className="mono shrink-0 font-semibold">
                {formatValue(item.value)}
                {item.subLabel ? (
                  <span className="font-normal text-muted-foreground"> · {item.subLabel}</span>
                ) : null}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${pct.toFixed(1)}%`, backgroundColor: item.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

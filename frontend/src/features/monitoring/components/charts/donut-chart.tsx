import { useMemo, useState } from "react";
import { Pie, PieChart, Sector } from "recharts";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  slices: DonutSlice[];
  centerLabel?: string;
  formatValue?: (v: number) => string;
}

export function DonutChart({
  slices,
  centerLabel = "总计",
  formatValue = (v) => v.toFixed(0),
}: DonutChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const positive = useMemo(
    () =>
      slices
        .filter((s) => s.value > 0)
        .map((s) => ({
          ...s,
          fill: s.color,
        })),
    [slices],
  );
  const total = useMemo(
    () => positive.reduce((acc, s) => acc + s.value, 0),
    [positive],
  );

  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    for (const s of positive) {
      cfg[s.key] = { label: s.label, color: s.color };
    }
    return cfg;
  }, [positive]);

  const activeSlice = positive.find((s) => s.key === hoveredKey);

  return (
    <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[164px_minmax(0,1fr)]">
      <div className="relative mx-auto size-[164px]">
        <ChartContainer config={chartConfig} className="size-[164px] aspect-square">
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(value, name) => {
                    const num = typeof value === "number" ? value : Number(value);
                    const pct = total > 0 ? ((num / total) * 100).toFixed(1) : "0.0";
                    return (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">{String(name)}</span>
                        <span className="mono font-medium">
                          {formatValue(num)} ({pct}%)
                        </span>
                      </div>
                    );
                  }}
                />
              }
            />
            <Pie
              data={positive}
              dataKey="value"
              nameKey="label"
              innerRadius={50}
              outerRadius={72}
              strokeWidth={2}
              isAnimationActive={false}
              shape={(props) => {
                const payload = props.payload as (DonutSlice & { fill: string }) | undefined;
                const dimmed = hoveredKey !== null && payload?.key !== hoveredKey;
                return (
                  <Sector
                    {...props}
                    fill={payload?.fill ?? props.fill}
                    fillOpacity={dimmed ? 0.35 : 1}
                  />
                );
              }}
              onMouseEnter={(_, idx) => {
                const target = positive[idx];
                if (target) setHoveredKey(target.key);
              }}
              onMouseLeave={() => {
                setHoveredKey(null);
              }}
            />
          </PieChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
          <span className="max-w-[92px] truncate text-[11px] text-muted-foreground">
            {activeSlice ? activeSlice.label : centerLabel}
          </span>
          <span className="mono text-sm font-semibold">
            {activeSlice ? formatValue(activeSlice.value) : formatValue(total)}
          </span>
        </div>
      </div>

      <div className="grid min-w-0 gap-1">
        {positive.map((a) => {
          const pct = total > 0 ? ((a.value / total) * 100).toFixed(1) : "0.0";
          return (
            <div
              key={a.key}
              className={cn(
                "grid grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
                hoveredKey === a.key ? "bg-muted" : "hover:bg-muted/50",
              )}
              onMouseEnter={() => {
                setHoveredKey(a.key);
              }}
              onMouseLeave={() => {
                setHoveredKey(null);
              }}
            >
              <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: a.color }} />
              <span className="truncate text-foreground" title={a.label}>
                {a.label}
              </span>
              <span className="mono font-medium">{formatValue(a.value)}</span>
              <span className="mono min-w-10 text-end text-muted-foreground">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

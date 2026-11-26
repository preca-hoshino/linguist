import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface LineSeriesDef {
  key: string;
  label: string;
  color: string;
  area?: boolean;
  dashed?: boolean;
}

export interface LinePoint {
  label: string;
  values: Record<string, number>;
}

interface LineAreaChartProps {
  data: LinePoint[];
  series: LineSeriesDef[];
  formatValue?: (v: number) => string;
  height?: number;
}

export function LineAreaChart({
  data,
  series,
  formatValue = (v) => v.toFixed(1),
  height = 220,
}: LineAreaChartProps) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    for (const s of series) {
      cfg[s.key] = { label: s.label, color: s.color };
    }
    return cfg;
  }, [series]);

  const flatData = useMemo(
    () =>
      data.map((pt) => ({
        label: pt.label,
        ...pt.values,
      })),
    [data],
  );

  const visibleSeries = useMemo(
    () => series.filter((s) => !hidden.has(s.key)),
    [series, hidden],
  );

  const toggleSeries = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size < series.length - 1) next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <ChartContainer
        config={chartConfig}
        className="w-full aspect-auto"
        style={{ height }}
      >
        <ComposedChart data={flatData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            fontSize={11}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={54}
            fontSize={11}
            tickFormatter={(v: number) => formatValue(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => {
                  const s = series.find((item) => item.key === String(name));
                  const num = typeof value === "number" ? value : Number(value);
                  return (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{s?.label ?? String(name)}</span>
                      <span className="mono font-medium">
                        {Number.isFinite(num) ? formatValue(num) : String(value)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {visibleSeries.map((s) =>
            s.area ? (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.key}
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.16}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.key}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                dot={false}
                isAnimationActive={false}
              />
            ),
          )}
        </ComposedChart>
      </ChartContainer>

      <div className="flex flex-wrap gap-1.5">
        {series.map((s) => {
          const isHidden = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                toggleSeries(s.key);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity",
                isHidden ? "opacity-45" : "bg-muted/40 hover:bg-muted",
              )}
            >
              <span
                className="size-2 rounded-[2px]"
                style={{ backgroundColor: s.color }}
              />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

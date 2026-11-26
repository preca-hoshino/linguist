import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface StackedSeriesDef {
  key: string;
  label: string;
  color: string;
}

export interface StackedBarPoint {
  label: string;
  values: Record<string, number>;
}

interface StackedBarChartProps {
  data: StackedBarPoint[];
  series: StackedSeriesDef[];
  formatValue?: (v: number) => string;
  height?: number;
}

export function StackedBarChart({
  data,
  series,
  formatValue = (v) => v.toFixed(0),
  height = 220,
}: StackedBarChartProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

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

  return (
    <div className="space-y-3">
      <ChartContainer config={chartConfig} className="w-full aspect-auto" style={{ height }}>
        <BarChart data={flatData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                  if (!num) return null;
                  return (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{s?.label ?? String(name)}</span>
                      <span className="mono font-medium">{formatValue(num)}</span>
                    </div>
                  );
                }}
              />
            }
          />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.key}
              stackId="stack"
              fill={s.color}
              fillOpacity={highlighted && highlighted !== s.key ? 0.25 : 0.92}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>

      <div className="flex flex-wrap gap-1.5">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              highlighted === s.key
                ? "border-primary bg-primary/10"
                : "bg-muted/40 hover:bg-muted",
            )}
            onMouseEnter={() => {
              setHighlighted(s.key);
            }}
            onMouseLeave={() => {
              setHighlighted(null);
            }}
            onClick={() => {
              setHighlighted((prev) => (prev === s.key ? null : s.key));
            }}
          >
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

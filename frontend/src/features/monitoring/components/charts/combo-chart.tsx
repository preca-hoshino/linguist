import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface ComboPoint {
  label: string;
  barValue: number;
  lineValue: number;
}

interface ComboChartProps {
  data: ComboPoint[];
  barLabel: string;
  lineLabel: string;
  barColor?: string;
  lineColor?: string;
  formatBar?: (v: number) => string;
  formatLine?: (v: number) => string;
  lineMax?: number;
  height?: number;
}

export function ComboChart({
  data,
  barLabel,
  lineLabel,
  barColor = "#5EEAD4",
  lineColor = "#4B7FFF",
  formatBar = (v) => v.toFixed(0),
  formatLine = (v) => `${v.toFixed(1)}%`,
  lineMax = 100,
  height = 220,
}: ComboChartProps) {
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      barValue: { label: barLabel, color: barColor },
      lineValue: { label: lineLabel, color: lineColor },
    }),
    [barColor, barLabel, lineColor, lineLabel],
  );

  return (
    <div className="space-y-3">
      <ChartContainer config={chartConfig} className="w-full aspect-auto" style={{ height }}>
        <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
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
            yAxisId="left"
            tickLine={false}
            axisLine={false}
            width={48}
            fontSize={11}
            tickFormatter={(v: number) => formatBar(v)}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, lineMax]}
            tickLine={false}
            axisLine={false}
            width={48}
            fontSize={11}
            tickFormatter={(v: number) => formatLine(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => {
                  const num = typeof value === "number" ? value : Number(value);
                  const isBar = String(name) === "barValue";
                  return (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{isBar ? barLabel : lineLabel}</span>
                      <span className="mono font-medium">
                        {isBar ? formatBar(num) : formatLine(num)}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <Bar
            yAxisId="left"
            dataKey="barValue"
            fill={barColor}
            fillOpacity={0.85}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="lineValue"
            stroke={lineColor}
            strokeWidth={2.2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>

      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
          <span className="size-2 rounded-[2px]" style={{ backgroundColor: barColor }} />
          {barLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
          <span className="size-2 rounded-[2px]" style={{ backgroundColor: lineColor }} />
          {lineLabel}
        </span>
      </div>
    </div>
  );
}

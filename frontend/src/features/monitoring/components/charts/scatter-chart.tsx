import { useMemo } from "react";
import {
  CartesianGrid,
  Scatter,
  ScatterChart as RechartsScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";

export interface ScatterPoint {
  key: string;
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
}

interface ScatterChartProps {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  formatSize?: (v: number) => string;
  height?: number;
}

const scatterConfig: ChartConfig = {
  point: { label: "模型性能" },
};

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  formatX = (v) => `${Math.round(v)}ms`,
  formatY = (v) => `${v.toFixed(1)} t/s`,
  formatSize = (v) => `${Math.round(v)} req`,
  height = 240,
}: ScatterChartProps) {
  const maxZ = useMemo(
    () => points.reduce((acc, p) => Math.max(acc, p.size), 1),
    [points],
  );

  return (
    <div className="space-y-2">
      <ChartContainer config={scatterConfig} className="w-full aspect-auto" style={{ height }}>
        <RechartsScatterChart margin={{ top: 12, right: 14, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            tickFormatter={(v: number) => formatX(v)}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={yLabel}
            tickLine={false}
            axisLine={false}
            width={56}
            fontSize={11}
            tickFormatter={(v: number) => formatY(v)}
          />
          <ZAxis type="number" dataKey="size" domain={[0, maxZ]} range={[80, 520]} />
          <ChartTooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || payload.length === 0) return null;
              const point = payload[0]?.payload as ScatterPoint | undefined;
              if (!point) return null;
              return (
                <div className="grid gap-1 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
                  <div className="font-semibold">{point.label}</div>
                  <div className="mono text-muted-foreground">
                    {xLabel}: <span className="text-foreground">{formatX(point.x)}</span>
                  </div>
                  <div className="mono text-muted-foreground">
                    {yLabel}: <span className="text-foreground">{formatY(point.y)}</span>
                  </div>
                  <div className="mono text-muted-foreground">
                    请求量: <span className="text-foreground">{formatSize(point.size)}</span>
                  </div>
                </div>
              );
            }}
          />
          <Scatter
            data={points}
            isAnimationActive={false}
            shape={(props: unknown) => {
              const p = props as {
                cx?: number;
                cy?: number;
                payload?: ScatterPoint;
              };
              const radius = p.payload
                ? 6 + Math.sqrt(p.payload.size / maxZ) * 10
                : 7;
              return (
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={radius}
                  fill={p.payload?.color ?? "#4B7FFF"}
                  fillOpacity={0.78}
                  stroke="var(--background)"
                  strokeWidth={1.5}
                />
              );
            }}
          />
        </RechartsScatterChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        横轴：{xLabel} · 纵轴：{yLabel}（越靠左上越优）· 气泡大小：请求量
      </p>
    </div>
  );
}

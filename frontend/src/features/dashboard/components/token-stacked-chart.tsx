import { useMemo, useState } from "react";
import { StackedBarChart } from "@/features/monitoring/components/charts/stacked-bar-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTokens, modelColor } from "../api";
import type { DailyMetric, DailyModelDay } from "../types";

interface TokenStackedChartProps {
  daysData: DailyModelDay[];
  daysWindow: number;
  onDaysWindowChange: (days: number) => void;
}

interface ModelSeriesInfo {
  key: string;
  modelName: string;
  color: string;
  total: number;
}

export function TokenStackedChart({
  daysData,
  daysWindow,
  onDaysWindowChange,
}: TokenStackedChartProps) {
  const [metric, setMetric] = useState<DailyMetric>("totalTokens");

  const { seriesList, chartPoints, maxDayTotal } = useMemo(() => {
    const totals = new Map<string, ModelSeriesInfo>();
    let peak = 0;

    const points = daysData.map((day) => {
      let daySum = 0;
      const values: Record<string, number> = {};
      for (const slice of day.models) {
        const val = slice[metric];
        daySum += val;
        const key = `${slice.providerId}/${slice.modelId}`;
        values[key] = (values[key] ?? 0) + val;
        const prev = totals.get(key);
        if (prev) {
          prev.total += val;
        } else {
          totals.set(key, {
            key,
            modelName: slice.modelName,
            color: modelColor(key),
            total: val,
          });
        }
      }
      if (daySum > peak) peak = daySum;
      return {
        label: day.date.slice(5),
        values,
      };
    });

    const sorted = Array.from(totals.values()).sort((a, b) => b.total - a.total);
    return { seriesList: sorted, chartPoints: points, maxDayTotal: peak };
  }, [daysData, metric]);

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 px-5 py-0">
        <div>
          <CardTitle className="text-base font-semibold">按天 Token 消耗柱状统计图</CardTitle>
          <CardDescription className="text-xs">
            按模型分色堆叠，悬停图例或柱体查看当日模型分布
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={String(daysWindow)}
            onValueChange={(v) => {
              onDaysWindowChange(Number(v));
            }}
          >
            <TabsList className="h-8">
              {[7, 14, 30, 90].map((d) => (
                <TabsTrigger key={d} value={String(d)} className="text-xs">
                  {d}天
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Tabs
            value={metric}
            onValueChange={(v) => {
              setMetric(v as DailyMetric);
            }}
          >
            <TabsList className="h-8">
              <TabsTrigger value="totalTokens" className="text-xs">
                总 Token
              </TabsTrigger>
              <TabsTrigger value="inputTokens" className="text-xs">
                输入
              </TabsTrigger>
              <TabsTrigger value="outputTokens" className="text-xs">
                输出
              </TabsTrigger>
              <TabsTrigger value="cacheReadTokens" className="text-xs">
                缓存
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>

      <CardContent className="px-5 py-0">
        {daysData.length === 0 || maxDayTotal === 0 ? (
          <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            当前过滤条件下暂无按天消耗数据
          </div>
        ) : (
          <StackedBarChart
            height={260}
            data={chartPoints}
            series={seriesList.map((s) => ({
              key: s.key,
              label: `${s.modelName} (${formatTokens(s.total)})`,
              color: s.color,
            }))}
            formatValue={formatTokens}
          />
        )}
      </CardContent>
    </Card>
  );
}

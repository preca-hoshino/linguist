import { useMemo, useState } from "react";
import { Activity, Cpu, Database, Flame, Layers, Wallet } from "lucide-react";
import { useTheme } from "@/context/theme-provider";
import { money, type BillingDashboard } from "@/features/logs/api";
import { LobeIcon } from "@/components/lobe-icon";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatInteger, formatTokens } from "../api";
import type { ContributionDayCell, OverviewSummary, WallMetric } from "../types";

interface ContributionWallProps {
  summary: OverviewSummary;
  days: ContributionDayCell[];
  billing: BillingDashboard | null;
  billingError: string;
  billingLoading: boolean;
}

interface GridCell {
  dateStr: string;
  weekIndex: number;
  dayOfWeek: number;
  data: ContributionDayCell | null;
}

interface TooltipState {
  x: number;
  y: number;
  dateStr: string;
  data: ContributionDayCell | null;
}

const LIGHT_WALL_COLORS = ["#EEF2F6", "#BFDBFE", "#60A5FA", "#4B7FFF", "#1E40AF"] as const;
const DARK_WALL_COLORS = ["#1E293B", "#1E3A8A", "#1D4ED8", "#3B82F6", "#60A5FA"] as const;
const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""] as const;

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function metricValue(cell: ContributionDayCell | null, metric: Exclude<WallMetric, "cost">): number {
  if (!cell) return 0;
  return cell[metric];
}

function quantileColor(value: number, maxVal: number, palette: readonly string[]): string {
  if (value <= 0 || maxVal <= 0) return palette[0] ?? "#EEF2F6";
  const ratio = value / maxVal;
  if (ratio < 0.2) return palette[1] ?? "#BFDBFE";
  if (ratio < 0.45) return palette[2] ?? "#60A5FA";
  if (ratio < 0.75) return palette[3] ?? "#4B7FFF";
  return palette[4] ?? "#1E40AF";
}

export function ContributionWall({
  summary,
  days,
  billing,
  billingError,
  billingLoading,
}: ContributionWallProps) {
  const { resolvedTheme } = useTheme();
  const wallColors = resolvedTheme === "dark" ? DARK_WALL_COLORS : LIGHT_WALL_COLORS;

  const [metric, setMetric] = useState<WallMetric>("totalTokens");
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState("");

  const useConverted = Boolean(billing?.wallCurrency && billing.wallApproximate);
  const costCurrency =
    selectedCurrency && (billing?.totals.some((total) => total.currency === selectedCurrency) ?? false)
      ? selectedCurrency
      : useConverted
        ? ""
        : (billing?.totals[0]?.currency ?? "");
  const currency = costCurrency || billing?.wallCurrency || "";
  const billingDays = useMemo(
    () => new Map(billing?.days.map((day) => [day.date, day]) ?? []),
    [billing],
  );

  const { cells, monthTicks, maxMetric, rangeStart } = useMemo(() => {
    const byDate = new Map<string, ContributionDayCell>();
    for (const item of days) {
      byDate.set(item.date, item);
    }

    const today = billing?.today ? new Date(`${billing.today}T00:00:00`) : new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    start.setDate(today.getDate() - 52 * 7 - today.getDay());
    const firstDay = new Date(today);
    firstDay.setDate(today.getDate() - 364);

    const builtCells: GridCell[] = [];
    const months: { weekIndex: number; label: string }[] = [];
    let prevMonth = -1;
    let peak = 0;

    for (let w = 0; w < 53; w += 1) {
      for (let d = 0; d < 7; d += 1) {
        const cur = new Date(start);
        cur.setDate(start.getDate() + w * 7 + d);
        if (cur > today) continue;

        const iso = toIsoDate(cur);
        const entry = byDate.get(iso) ?? null;
        const costDay = billingDays.get(iso);
        const cost = costCurrency
          ? costDay?.totals.find((total) => total.currency === costCurrency)?.amount
          : costDay?.wallAmount;
        const val = metric === "cost" ? Number(cost ?? 0) : metricValue(entry, metric);
        if (val > peak) peak = val;

        if (d === 0 && cur.getMonth() !== prevMonth) {
          prevMonth = cur.getMonth();
          months.push({
            weekIndex: w,
            label: cur.toLocaleDateString("zh-CN", { month: "short" }),
          });
        }

        builtCells.push({
          dateStr: iso,
          weekIndex: w,
          dayOfWeek: d,
          data: entry,
        });
      }
    }

    return {
      cells: builtCells,
      monthTicks: months,
      maxMetric: peak,
      rangeStart: toIsoDate(firstDay),
    };
  }, [days, metric, billingDays, costCurrency, billing?.today]);

  const cellSize = 12;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const leftPad = 32;
  const topPad = 20;
  const svgWidth = leftPad + 53 * step + 8;
  const svgHeight = topPad + 7 * step + 6;
  const tickColor = resolvedTheme === "dark" ? "#94A3B8" : "#64748B";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">周期总消耗 Token</CardTitle>
            <Flame className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            <div className="mono text-2xl font-bold">{formatTokens(summary.totalTokens)}</div>
            <p className="mono mt-1 text-xs text-muted-foreground">
              {formatInteger(summary.totalTokens)} tokens
            </p>
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">总输入 / 总输出</CardTitle>
            <Layers className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            <div className="mono text-xl font-bold">
              {formatTokens(summary.inputTokens)}
              <span className="mx-1 text-sm font-normal text-muted-foreground">/</span>
              {formatTokens(summary.outputTokens)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Prompt vs Completion</p>
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">缓存命中</CardTitle>
            <Database className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            <div className="mono text-2xl font-bold">{formatTokens(summary.cacheReadTokens)}</div>
            <p className="mono mt-1 text-xs text-muted-foreground">
              命中率 {summary.cacheHitRate.toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              请求总数 / 连续活跃
            </CardTitle>
            <Activity className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            <div className="flex items-baseline gap-2">
              <span className="mono text-2xl font-bold">{formatInteger(summary.totalRequests)}</span>
              <Badge variant="secondary" className="mono text-[10px]">
                {summary.activeStreakDays}d streak
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">含全部已入库请求</p>
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">最常用模型</CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            <div className="flex items-center gap-2">
              {summary.topModel ? (
                <>
                  <LobeIcon
                    slug={summary.topModel.modelIcon}
                    label={summary.topModel.modelName}
                    size={18}
                  />
                  <span className="truncate text-sm font-bold" title={summary.topModel.modelName}>
                    {summary.topModel.modelName}
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">暂无数据</span>
              )}
            </div>
            <p className="mono mt-1.5 text-xs text-muted-foreground">
              {summary.topModel ? `${formatTokens(summary.topModel.totalTokens)} tokens` : "—"}
            </p>
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
            <CardTitle className="text-xs font-medium text-muted-foreground">周期消费</CardTitle>
            <Wallet className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 py-0">
            {billing ? (
              <>
                <div className="mono truncate text-lg font-bold">
                  {billing.convertedTotal !== null && billing.displayCurrency
                    ? `${billing.totals.some((total) => total.currency !== billing.displayCurrency) ? "≈ " : ""}${money(billing.convertedTotal, billing.displayCurrency)}`
                    : billing.totals.length
                      ? billing.totals
                          .map((total) => money(total.amount, total.currency))
                          .join(" · ")
                      : "—"}
                </div>
                <p className="mono mt-1 truncate text-xs text-muted-foreground">
                  未计价 {formatInteger(billing.unpriced)}
                </p>
              </>
            ) : (
              <>
                <div className="mono text-lg font-bold">—</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {billingLoading ? "加载中…" : billingError || "暂无账单数据"}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-4 py-5">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 px-5 py-0">
          <div>
            <CardTitle className="text-base font-semibold">统计墙</CardTitle>
            <CardDescription className="text-xs">
              近 53 周按日消耗与请求活跃度热力矩阵
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {metric === "cost" && billing ? (
              <Select
                value={costCurrency || (useConverted ? "__converted__" : "__empty__")}
                onValueChange={(v) => {
                  setSelectedCurrency(v === "__converted__" || v === "__empty__" ? "" : v);
                }}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue placeholder="选择币种" />
                </SelectTrigger>
                <SelectContent>
                  {useConverted ? (
                    <SelectItem value="__converted__">
                      参考折算 · {billing.wallCurrency}
                    </SelectItem>
                  ) : null}
                  {billing.totals.map((total) => (
                    <SelectItem key={total.currency} value={total.currency}>
                      {total.currency}
                    </SelectItem>
                  ))}
                  {!billing.totals.length ? (
                    <SelectItem value="__empty__">暂无费用</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            ) : null}

            <Tabs
              value={metric}
              onValueChange={(v) => {
                setMetric(v as WallMetric);
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="totalTokens" className="text-xs">
                  总 Token
                </TabsTrigger>
                <TabsTrigger value="outputTokens" className="text-xs">
                  输出 Token
                </TabsTrigger>
                <TabsTrigger value="requestCount" className="text-xs">
                  请求次数
                </TabsTrigger>
                <TabsTrigger value="cost" className="text-xs">
                  费用
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>

        <CardContent className="px-5 py-0">
          <div className="overflow-x-auto pb-1">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              width="100%"
              style={{ minWidth: 740, display: "block" }}
              role="img"
              aria-label={
                metric === "cost"
                  ? `53 周费用热力图 ${currency}`
                  : "53-week token contribution heatmap"
              }
            >
              {monthTicks.map((tick) => (
                <text
                  key={`${tick.weekIndex}-${tick.label}`}
                  x={leftPad + tick.weekIndex * step}
                  y={12}
                  fontSize={10}
                  fill={tickColor}
                >
                  {tick.label}
                </text>
              ))}

              {WEEKDAY_LABELS.map((label, idx) =>
                label ? (
                  <text
                    key={label}
                    x={0}
                    y={topPad + idx * step + 10}
                    fontSize={10}
                    fill={tickColor}
                  >
                    {label}
                  </text>
                ) : null,
              )}

              {cells.map((cell) => {
                const costDay = billingDays.get(cell.dateStr);
                const cost = costCurrency
                  ? costDay?.totals.find((total) => total.currency === costCurrency)?.amount
                  : costDay?.wallAmount;
                const val =
                  metric === "cost" ? Number(cost ?? 0) : metricValue(cell.data, metric);
                const fill = quantileColor(val, maxMetric, wallColors);
                return (
                  <rect
                    key={cell.dateStr}
                    x={leftPad + cell.weekIndex * step}
                    y={topPad + cell.dayOfWeek * step}
                    width={cellSize}
                    height={cellSize}
                    rx={2.5}
                    fill={fill}
                    className="cursor-pointer transition-opacity hover:opacity-80"
                    onMouseEnter={(e) => {
                      setTooltip({
                        x: e.clientX,
                        y: e.clientY,
                        dateStr: cell.dateStr,
                        data: cell.data,
                      });
                    }}
                    onMouseMove={(e) => {
                      setTooltip({
                        x: e.clientX,
                        y: e.clientY,
                        dateStr: cell.dateStr,
                        data: cell.data,
                      });
                    }}
                    onMouseLeave={() => {
                      setTooltip(null);
                    }}
                  />
                );
              })}
            </svg>
          </div>

          <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
            <span>Less</span>
            {wallColors.map((color) => (
              <span
                key={color}
                className="size-2.5 rounded-[2px]"
                style={{ backgroundColor: color }}
              />
            ))}
            <span>More</span>
          </div>
        </CardContent>
      </Card>

      {tooltip ? (
        <div
          className="pointer-events-none fixed z-50 max-w-64 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{
            left: Math.min(tooltip.x + 14, window.innerWidth - 230),
            top: Math.min(tooltip.y + 14, window.innerHeight - 160),
          }}
        >
          <div className="mono mb-1 font-semibold">{tooltip.dateStr}</div>
          {tooltip.dateStr < rangeStart ? (
            <div className="text-muted-foreground">不在统计范围</div>
          ) : tooltip.data ? (
            <div className="mono space-y-0.5 text-[11px]">
              <div>总消耗: {formatInteger(tooltip.data.totalTokens)} tok</div>
              <div>输入: {formatInteger(tooltip.data.inputTokens)}</div>
              <div>输出: {formatInteger(tooltip.data.outputTokens)}</div>
              <div>缓存命中: {formatInteger(tooltip.data.cacheReadTokens)}</div>
              <div>请求次数: {formatInteger(tooltip.data.requestCount)}</div>
            </div>
          ) : !billingDays.has(tooltip.dateStr) ? (
            <div className="text-[11px] text-muted-foreground">当日无请求记录</div>
          ) : null}

          {billingDays.get(tooltip.dateStr) ? (
            <div className="mono mt-1 border-t pt-1 text-[11px]">
              <div>
                费用:{" "}
                {billingDays
                  .get(tooltip.dateStr)
                  ?.totals.map((total) => money(total.amount, total.currency))
                  .join(" · ") || "—"}
              </div>
              {useConverted &&
              !costCurrency &&
              billingDays.get(tooltip.dateStr)?.wallAmount ? (
                <div>
                  参考折算: ≈{" "}
                  {money(billingDays.get(tooltip.dateStr)?.wallAmount ?? null, currency)}
                </div>
              ) : null}
              <div>未计价: {billingDays.get(tooltip.dateStr)?.unpriced}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

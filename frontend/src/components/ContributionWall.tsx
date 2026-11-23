import { useMemo, useState } from "react";
import { formatInteger, formatTokens } from "../api/client";
import type { ContributionDayCell, OverviewSummary, WallMetric } from "../types/telemetry";
import { money } from "../billing/api";
import type { BillingDashboard } from "../billing/api";
import { LobeIcon } from "./LobeIcon";

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

const WALL_COLORS = ["#EEF2F6", "#BFDBFE", "#60A5FA", "#4B7FFF", "#1E40AF"] as const;
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

function quantileColor(value: number, maxVal: number): string {
  if (value <= 0 || maxVal <= 0) return WALL_COLORS[0];
  const ratio = value / maxVal;
  if (ratio < 0.2) return WALL_COLORS[1];
  if (ratio < 0.45) return WALL_COLORS[2];
  if (ratio < 0.75) return WALL_COLORS[3];
  return WALL_COLORS[4];
}

export function ContributionWall({ summary, days, billing, billingError, billingLoading }: ContributionWallProps) {
  const [metric, setMetric] = useState<WallMetric>("totalTokens");
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState("");
  const useConverted = Boolean(billing?.wallCurrency && billing.wallApproximate);
  const costCurrency = selectedCurrency && (billing?.totals.some((total) => total.currency === selectedCurrency) ?? false)
    ? selectedCurrency : useConverted ? "" : billing?.totals[0]?.currency ?? "";
  const currency = costCurrency || billing?.wallCurrency || "";
  const billingDays = useMemo(() => new Map(billing?.days.map((day) => [day.date, day]) ?? []), [billing]);

  const { cells, monthTicks, maxMetric, rangeStart } = useMemo(() => {
    const byDate = new Map<string, ContributionDayCell>();
    for (const item of days) {
      byDate.set(item.date, item);
    }

    const today = billing?.today ? new Date(`${billing.today}T00:00:00`) : new Date();
    today.setHours(0, 0, 0, 0);

    // Align 53-week matrix starting on Sunday 52 weeks prior.
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
        const cost = costCurrency ? costDay?.totals.find((total) => total.currency === costCurrency)?.amount : costDay?.wallAmount;
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

    return { cells: builtCells, monthTicks: months, maxMetric: peak, rangeStart: toIsoDate(firstDay) };
  }, [days, metric, billingDays, costCurrency, billing?.today]);

  const cellSize = 12;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const leftPad = 32;
  const topPad = 20;
  const svgWidth = leftPad + 53 * step + 8;
  const svgHeight = topPad + 7 * step + 6;

  return (
    <section className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">统计墙</h2>
          <p className="section-desc">近 53 周按日消耗与请求活跃度热力矩阵</p>
        </div>
        <div className="segmented-group" role="tablist" aria-label="Wall metric">
          {(
            [
              ["totalTokens", "总 Token"],
              ["outputTokens", "输出 Token"],
              ["requestCount", "请求次数"],
              ["cost", "费用"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`segmented-btn ${metric === key ? "active" : ""}`}
              aria-pressed={metric === key}
              onClick={() => {
                setMetric(key);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-tile">
          <div className="kpi-label">周期总消耗 Token</div>
          <div className="kpi-value mono">{formatTokens(summary.totalTokens)}</div>
          <div className="kpi-sub mono">{formatInteger(summary.totalTokens)} tokens</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">总输入 / 总输出</div>
          <div className="kpi-value mono">
            {formatTokens(summary.inputTokens)}
            <span style={{ color: "var(--ink-muted)", fontSize: 13 }}>/</span>
            {formatTokens(summary.outputTokens)}
          </div>
          <div className="kpi-sub">Prompt vs Completion</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">缓存命中</div>
          <div className="kpi-value mono">{formatTokens(summary.cacheReadTokens)}</div>
          <div className="kpi-sub mono">命中率 {summary.cacheHitRate.toFixed(1)}%</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">请求总数 / 连续活跃</div>
          <div className="kpi-value mono">
            {formatInteger(summary.totalRequests)}
            <span style={{ color: "var(--accent-blue)", fontSize: 13 }}>
              {summary.activeStreakDays}d streak
            </span>
          </div>
          <div className="kpi-sub">含全部已入库请求</div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">最常用模型</div>
          <div className="kpi-value" style={{ fontSize: 14 }}>
            {summary.topModel ? (
              <>
                <LobeIcon
                  slug={summary.topModel.modelIcon}
                  label={summary.topModel.modelName}
                  size={20}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {summary.topModel.modelName}
                </span>
              </>
            ) : (
              <span style={{ color: "var(--ink-muted)" }}>暂无数据</span>
            )}
          </div>
          <div className="kpi-sub mono">
            {summary.topModel ? `${formatTokens(summary.topModel.totalTokens)} tokens` : "—"}
          </div>
        </div>
        <div className="kpi-tile">
          <div className="kpi-label">周期消费</div>
          {billing ? <>
            <div className="kpi-value billing-kpi-value mono">{billing.convertedTotal !== null && billing.displayCurrency
              ? `${billing.totals.some((total) => total.currency !== billing.displayCurrency) ? "≈ " : ""}${money(billing.convertedTotal, billing.displayCurrency)}`
              : billing.totals.length ? billing.totals.map((total) => money(total.amount, total.currency)).join(" · ") : "—"}</div>
            {billing.convertedTotal !== null && billing.totals.some((total) => total.currency !== billing.displayCurrency) ? <div className="kpi-sub mono">{billing.totals.map((total) => money(total.amount, total.currency)).join(" · ")}</div> : null}
            <div className="kpi-sub">未计价 {formatInteger(billing.unpriced)}</div>
          </> : <>
            <div className="kpi-value mono">—</div>
            {billingLoading ? <div className="kpi-sub" role="status">加载中…</div> : null}
            {billingError ? <div className="kpi-sub" role="alert">{billingError}</div> : null}
          </>}
        </div>
      </div>

      {metric === "cost" && billing ? <div className="billing-wall-controls">
        <label>币种 <select className="select-control" value={costCurrency} onChange={(event) => { setSelectedCurrency(event.target.value); }}>
          {useConverted ? <option value="">参考折算 · {billing.wallCurrency}</option> : null}
          {billing.totals.map((total) => <option key={total.currency} value={total.currency}>{total.currency}</option>)}
          {!billing.totals.length ? <option value="">暂无费用</option> : null}
        </select></label>
      </div> : null}
      <div className="wall-wrapper">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width="100%"
          style={{ minWidth: 740, display: "block" }}
          role="img"
          aria-label={metric === "cost" ? `53 周费用热力图 ${currency}` : "53-week token contribution heatmap"}
        >
          {monthTicks.map((tick) => (
            <text
              key={`${tick.weekIndex}-${tick.label}`}
              x={leftPad + tick.weekIndex * step}
              y={12}
              fontSize={10}
              fill="#64748B"
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
                fill="#64748B"
              >
                {label}
              </text>
            ) : null,
          )}

          {cells.map((cell) => {
            const costDay = billingDays.get(cell.dateStr);
            const cost = costCurrency ? costDay?.totals.find((total) => total.currency === costCurrency)?.amount : costDay?.wallAmount;
            const val = metric === "cost" ? Number(cost ?? 0) : metricValue(cell.data, metric);
            const fill = quantileColor(val, maxMetric);
            return (
              <rect
                key={cell.dateStr}
                x={leftPad + cell.weekIndex * step}
                y={topPad + cell.dayOfWeek * step}
                width={cellSize}
                height={cellSize}
                rx={2.5}
                fill={fill}
                style={{ cursor: "pointer" }}
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

      <div className="wall-legend">
        <span>Less</span>
        {WALL_COLORS.map((color) => (
          <span key={color} className="legend-swatch" style={{ backgroundColor: color }} />
        ))}
        <span>More</span>
      </div>

      {tooltip ? (
        <div
          className="tooltip-box"
          style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
        >
          <div className="mono" style={{ fontWeight: 600, marginBottom: 4 }}>
            {tooltip.dateStr}
          </div>
          {tooltip.dateStr < rangeStart ? <div>不在统计范围</div> : tooltip.data ? (
            <div className="mono" style={{ fontSize: 11 }}>
              <div>总消耗: {formatInteger(tooltip.data.totalTokens)} tok</div>
              <div>输入: {formatInteger(tooltip.data.inputTokens)}</div>
              <div>输出: {formatInteger(tooltip.data.outputTokens)}</div>
              <div>缓存命中: {formatInteger(tooltip.data.cacheReadTokens)}</div>
              <div>请求次数: {formatInteger(tooltip.data.requestCount)}</div>
            </div>
          ) : !billingDays.has(tooltip.dateStr) ? (
            <div style={{ fontSize: 11, color: "#CBD5E1" }}>当日无请求记录</div>
          ) : null}
          {billingDays.get(tooltip.dateStr) ? <div className="mono">
            <div>费用: {billingDays.get(tooltip.dateStr)?.totals.map((total) => money(total.amount, total.currency)).join(" · ") || "—"}</div>
            {useConverted && !costCurrency && billingDays.get(tooltip.dateStr)?.wallAmount ? <div>参考折算: ≈ {money(billingDays.get(tooltip.dateStr)?.wallAmount ?? null, currency)}</div> : null}
            <div>未计价: {billingDays.get(tooltip.dateStr)?.unpriced}</div>
          </div> : null}
        </div>
      ) : null}
    </section>
  );
}

import { useMemo, useState } from "react";
import { formatTokens, modelColor } from "../api/client";
import type { DailyMetric, DailyModelDay } from "../types/telemetry";

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

interface ChartTooltip {
  x: number;
  y: number;
  date: string;
  total: number;
  slices: { key: string; name: string; color: string; value: number }[];
}

export function TokenStackedChart({
  daysData,
  daysWindow,
  onDaysWindowChange,
}: TokenStackedChartProps) {
  const [metric, setMetric] = useState<DailyMetric>("totalTokens");
  const [highlightedModel, setHighlightedModel] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<ChartTooltip | null>(null);

  const { seriesList, maxDayTotal } = useMemo(() => {
    const totals = new Map<string, ModelSeriesInfo>();
    let peak = 0;

    for (const day of daysData) {
      let daySum = 0;
      for (const slice of day.models) {
        const val = slice[metric];
        daySum += val;
        const key = `${slice.providerId}/${slice.modelId}`;
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
    }

    const sorted = Array.from(totals.values()).sort((a, b) => b.total - a.total);
    return { seriesList: sorted, maxDayTotal: peak };
  }, [daysData, metric]);

  const svgWidth = 960;
  const svgHeight = 260;
  const padLeft = 58;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 34;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;
  const barSlot = daysData.length > 0 ? plotW / daysData.length : plotW;
  const barW = Math.max(3, Math.min(28, barSlot * 0.72));
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const labelStride = daysData.length <= 14 ? 1 : daysData.length <= 30 ? 3 : 9;

  return (
    <section className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">按天 Token 消耗柱状统计图</h2>
          <p className="section-desc">按模型分色堆叠，悬停图例或柱体查看当日模型分布</p>
        </div>

        <div className="filter-pills">
          <div className="segmented-group" role="tablist" aria-label="Daily window">
            {[7, 14, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={`segmented-btn ${daysWindow === d ? "active" : ""}`}
                onClick={() => {
                  onDaysWindowChange(d);
                }}
              >
                {d}天
              </button>
            ))}
          </div>

          <div className="segmented-group" role="tablist" aria-label="Daily metric">
            {(
              [
                ["totalTokens", "总 Token"],
                ["inputTokens", "输入"],
                ["outputTokens", "输出"],
                ["cacheReadTokens", "缓存"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segmented-btn ${metric === key ? "active" : ""}`}
                onClick={() => {
                  setMetric(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {daysData.length === 0 || maxDayTotal === 0 ? (
        <div className="empty-state">当前过滤条件下暂无按天消耗数据</div>
      ) : (
        <>
          <div className="wall-wrapper">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              width="100%"
              style={{ minWidth: 680, display: "block" }}
              role="img"
              aria-label="Daily token consumption stacked bar chart"
            >
              {yTicks.map((ratio) => {
                const y = padTop + plotH * (1 - ratio);
                const val = maxDayTotal * ratio;
                return (
                  <g key={ratio}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={svgWidth - padRight}
                      y2={y}
                      stroke="#E5E2DC"
                      strokeDasharray={ratio === 0 ? undefined : "3 3"}
                    />
                    <text
                      x={padLeft - 8}
                      y={y + 3}
                      textAnchor="end"
                      fontSize={10}
                      fill="#64748B"
                      className="mono"
                    >
                      {formatTokens(val)}
                    </text>
                  </g>
                );
              })}

              {daysData.map((day, dayIdx) => {
                const x = padLeft + dayIdx * barSlot + (barSlot - barW) / 2;
                let yCursor = padTop + plotH;
                const slicesInfo: ChartTooltip["slices"] = [];
                let dayTotal = 0;

                const rects = day.models.map((slice) => {
                  const val = slice[metric];
                  dayTotal += val;
                  const key = `${slice.providerId}/${slice.modelId}`;
                  const color = modelColor(key);
                  slicesInfo.push({
                    key,
                    name: slice.modelName,
                    color,
                    value: val,
                  });

                  if (val <= 0) return null;
                  const h = (val / maxDayTotal) * plotH;
                  yCursor -= h;
                  const dimmed = highlightedModel !== null && highlightedModel !== key;
                  return (
                    <rect
                      key={key}
                      x={x}
                      y={yCursor}
                      width={barW}
                      height={Math.max(1, h)}
                      fill={color}
                      opacity={dimmed ? 0.22 : 0.95}
                      rx={1.5}
                    />
                  );
                });

                const showLabel =
                  dayIdx % labelStride === 0 || dayIdx === daysData.length - 1;

                return (
                  <g key={day.date}>
                    {rects}
                    <rect
                      x={padLeft + dayIdx * barSlot}
                      y={padTop}
                      width={barSlot}
                      height={plotH}
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onMouseEnter={(e) => {
                        setTooltip({
                          x: e.clientX,
                          y: e.clientY,
                          date: day.date,
                          total: dayTotal,
                          slices: slicesInfo.filter((s) => s.value > 0),
                        });
                      }}
                      onMouseMove={(e) => {
                        setTooltip({
                          x: e.clientX,
                          y: e.clientY,
                          date: day.date,
                          total: dayTotal,
                          slices: slicesInfo.filter((s) => s.value > 0),
                        });
                      }}
                      onMouseLeave={() => {
                        setTooltip(null);
                      }}
                    />
                    {showLabel ? (
                      <text
                        x={x + barW / 2}
                        y={svgHeight - 10}
                        textAnchor="middle"
                        fontSize={10}
                        fill="#64748B"
                        className="mono"
                      >
                        {day.date.slice(5)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="chart-legend">
            {seriesList.map((series) => (
              <button
                key={series.key}
                type="button"
                className={`chart-legend-item ${highlightedModel === series.key ? "active" : ""}`}
                onMouseEnter={() => {
                  setHighlightedModel(series.key);
                }}
                onMouseLeave={() => {
                  setHighlightedModel(null);
                }}
                onClick={() => {
                  setHighlightedModel((cur) => (cur === series.key ? null : series.key));
                }}
              >
                <span className="legend-dot" style={{ backgroundColor: series.color }} />
                <span>{series.modelName}</span>
                <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                  {formatTokens(series.total)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {tooltip ? (
        <div
          className="tooltip-box"
          style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
        >
          <div className="mono" style={{ fontWeight: 600, marginBottom: 4 }}>
            {tooltip.date} · {formatTokens(tooltip.total)}
          </div>
          {tooltip.slices.length === 0 ? (
            <div style={{ fontSize: 11, color: "#CBD5E1" }}>无消耗</div>
          ) : (
            tooltip.slices.slice(0, 6).map((s) => {
              const pct = tooltip.total > 0 ? ((s.value / tooltip.total) * 100).toFixed(0) : "0";
              return (
                <div
                  key={s.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    fontSize: 11,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 2,
                        backgroundColor: s.color,
                      }}
                    />
                    {s.name}
                  </span>
                  <span className="mono">
                    {formatTokens(s.value)} ({pct}%)
                  </span>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}

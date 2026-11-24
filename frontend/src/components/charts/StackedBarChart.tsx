import { useMemo, useState } from "react";

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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const maxTotal = useMemo(() => {
    let peak = 0;
    for (const pt of data) {
      let sum = 0;
      for (const s of series) {
        sum += pt.values[s.key] ?? 0;
      }
      if (sum > peak) peak = sum;
    }
    return peak > 0 ? peak * 1.08 : 1;
  }, [data, series]);

  const svgWidth = 640;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 30;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.max(3, Math.min(24, slotW * 0.72));
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const labelStride = Math.max(1, Math.ceil(data.length / 6));

  const hovered = hoverIdx !== null ? data[hoverIdx] : undefined;

  return (
    <div>
      <div className="monitoring-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${height}`}
          className="monitoring-svg"
          role="img"
          aria-label="堆叠柱状统计图"
          onMouseLeave={() => { setHoverIdx(null); }}
        >
          {yTicks.map((t) => {
            const y = padTop + plotH * (1 - t);
            return (
              <g key={t}>
                <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="#E5E2DC" strokeDasharray="3 3" />
                <text x={padLeft - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#64748B" className="mono">
                  {formatValue(maxTotal * t)}
                </text>
              </g>
            );
          })}

          {data.map((pt, i) => {
            const x = padLeft + i * slotW + (slotW - barW) / 2;
            let cursorY = padTop + plotH;
            return (
              <g key={`${pt.label}-${i}`}>
                {series.map((s) => {
                  const val = pt.values[s.key] ?? 0;
                  if (val <= 0) return null;
                  const h = (val / maxTotal) * plotH;
                  cursorY -= h;
                  const dimmed = highlighted !== null && highlighted !== s.key;
                  return (
                    <rect
                      key={s.key}
                      x={x}
                      y={cursorY}
                      width={barW}
                      height={Math.max(1, h)}
                      fill={s.color}
                      opacity={dimmed ? 0.24 : 0.92}
                      rx={1.5}
                    />
                  );
                })}
                {(i % labelStride === 0 || i === data.length - 1) ? (
                  <text
                    x={x + barW / 2}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize="10"
                    fill="#64748B"
                    className="mono"
                  >
                    {pt.label}
                  </text>
                ) : null}
                <rect
                  x={padLeft + i * slotW}
                  y={padTop}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    setHoverIdx(i);
                    setMousePos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e) => {
                    setMousePos({ x: e.clientX, y: e.clientY });
                  }}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="chart-legend">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`chart-legend-item${highlighted === s.key ? " active" : ""}`}
            onMouseEnter={() => { setHighlighted(s.key); }}
            onMouseLeave={() => { setHighlighted(null); }}
            onClick={() => { setHighlighted((prev) => (prev === s.key ? null : s.key)); }}
          >
            <span className="legend-dot" style={{ backgroundColor: s.color }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {hovered ? (
        <div className="tooltip-box" style={{ left: mousePos.x + 12, top: mousePos.y - 12 }}>
          <div className="mono" style={{ fontWeight: 600, marginBottom: 4 }}>{hovered.label}</div>
          {series.map((s) => {
            const val = hovered.values[s.key] ?? 0;
            if (val <= 0) return null;
            return (
              <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: "#CBD5E1" }}>{s.label}</span>
                <span className="mono">{formatValue(val)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

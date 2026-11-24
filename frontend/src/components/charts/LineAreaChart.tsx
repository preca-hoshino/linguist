import { useMemo, useState } from "react";

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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const visibleSeries = useMemo(
    () => series.filter((s) => !hidden.has(s.key)),
    [series, hidden],
  );

  const maxVal = useMemo(() => {
    let peak = 0;
    for (const pt of data) {
      for (const s of visibleSeries) {
        const v = pt.values[s.key] ?? 0;
        if (v > peak) peak = v;
      }
    }
    return peak > 0 ? peak * 1.1 : 1;
  }, [data, visibleSeries]);

  const svgWidth = 640;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 30;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xAt = (i: number) =>
    data.length <= 1 ? padLeft + plotW / 2 : padLeft + (i / (data.length - 1)) * plotW;
  const yAt = (v: number) => padTop + plotH - (v / maxVal) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const labelStride = Math.max(1, Math.ceil(data.length / 6));

  const toggleSeries = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (next.size < series.length - 1) next.add(key);
      return next;
    });
  };

  const hovered = hoverIdx !== null ? data[hoverIdx] : undefined;

  return (
    <div>
      <div className="monitoring-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${height}`}
          className="monitoring-svg"
          role="img"
          aria-label="折线趋势图"
          onMouseLeave={() => { setHoverIdx(null); }}
        >
          {yTicks.map((t) => {
            const y = padTop + plotH * (1 - t);
            return (
              <g key={t}>
                <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="#E5E2DC" strokeDasharray="3 3" />
                <text x={padLeft - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#64748B" className="mono">
                  {formatValue(maxVal * t)}
                </text>
              </g>
            );
          })}

          {visibleSeries.map((s) => {
            if (data.length === 0) return null;
            const pts = data.map((pt, i) => `${xAt(i).toFixed(1)},${yAt(pt.values[s.key] ?? 0).toFixed(1)}`);
            const linePath = `M${pts.join(" L")}`;
            const areaPath = `${linePath} L${xAt(data.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${xAt(0).toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;
            return (
              <g key={s.key}>
                {s.area ? <path d={areaPath} fill={s.color} fillOpacity={0.14} /> : null}
                <path
                  d={linePath}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? "5 4" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {hoverIdx !== null && data[hoverIdx] ? (
            <g>
              <line
                x1={xAt(hoverIdx)}
                y1={padTop}
                x2={xAt(hoverIdx)}
                y2={padTop + plotH}
                stroke="#94A3B8"
                strokeDasharray="2 2"
              />
              {visibleSeries.map((s) => (
                <circle
                  key={s.key}
                  cx={xAt(hoverIdx)}
                  cy={yAt(data[hoverIdx]?.values[s.key] ?? 0)}
                  r={3.5}
                  fill={s.color}
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                />
              ))}
            </g>
          ) : null}

          {data.map((pt, i) => {
            const slotW = data.length > 1 ? plotW / data.length : plotW;
            const x = xAt(i) - slotW / 2;
            return (
              <g key={`${pt.label}-${i}`}>
                {(i % labelStride === 0 || i === data.length - 1) ? (
                  <text
                    x={xAt(i)}
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
                  x={Math.max(padLeft, x)}
                  y={padTop}
                  width={Math.max(6, slotW)}
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
        {series.map((s) => {
          const isHidden = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              className={`chart-legend-item${isHidden ? " muted" : ""}`}
              onClick={() => { toggleSeries(s.key); }}
            >
              <span className="legend-dot" style={{ backgroundColor: s.color, opacity: isHidden ? 0.3 : 1 }} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      {hovered ? (
        <div className="tooltip-box" style={{ left: mousePos.x + 12, top: mousePos.y - 12 }}>
          <div className="mono" style={{ fontWeight: 600, marginBottom: 4 }}>{hovered.label}</div>
          {visibleSeries.map((s) => (
            <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ color: "#CBD5E1" }}>{s.label}</span>
              <span className="mono">{formatValue(hovered.values[s.key] ?? 0)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

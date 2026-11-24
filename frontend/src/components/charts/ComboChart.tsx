import { useMemo, useState } from "react";

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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const maxBar = useMemo(() => {
    let peak = 0;
    for (const pt of data) {
      if (pt.barValue > peak) peak = pt.barValue;
    }
    return peak > 0 ? peak * 1.1 : 1;
  }, [data]);

  const svgWidth = 640;
  const padLeft = 52;
  const padRight = 46;
  const padTop = 14;
  const padBottom = 30;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.max(4, Math.min(26, slotW * 0.56));
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const labelStride = Math.max(1, Math.ceil(data.length / 6));

  const xCenter = (i: number) => padLeft + i * slotW + slotW / 2;
  const yLine = (v: number) => padTop + plotH - (Math.min(lineMax, Math.max(0, v)) / lineMax) * plotH;

  const linePath = data.length > 0
    ? `M${data.map((pt, i) => `${xCenter(i).toFixed(1)},${yLine(pt.lineValue).toFixed(1)}`).join(" L")}`
    : "";

  const hovered = hoverIdx !== null ? data[hoverIdx] : undefined;

  return (
    <div>
      <div className="monitoring-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${height}`}
          className="monitoring-svg"
          role="img"
          aria-label="双轴组合统计图"
          onMouseLeave={() => { setHoverIdx(null); }}
        >
          {yTicks.map((t) => {
            const y = padTop + plotH * (1 - t);
            return (
              <g key={t}>
                <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="#E5E2DC" strokeDasharray="3 3" />
                <text x={padLeft - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#64748B" className="mono">
                  {formatBar(maxBar * t)}
                </text>
                <text x={svgWidth - padRight + 6} y={y + 4} textAnchor="start" fontSize="10" fill="#64748B" className="mono">
                  {formatLine(lineMax * t)}
                </text>
              </g>
            );
          })}

          {data.map((pt, i) => {
            const h = (pt.barValue / maxBar) * plotH;
            const x = xCenter(i) - barW / 2;
            const y = padTop + plotH - h;
            return (
              <g key={`${pt.label}-${i}`}>
                {pt.barValue > 0 ? (
                  <rect x={x} y={y} width={barW} height={Math.max(1, h)} fill={barColor} opacity={0.85} rx={2} />
                ) : null}
                {(i % labelStride === 0 || i === data.length - 1) ? (
                  <text
                    x={xCenter(i)}
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

          {linePath ? (
            <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          ) : null}

          {hoverIdx !== null && data[hoverIdx] ? (
            <circle
              cx={xCenter(hoverIdx)}
              cy={yLine(data[hoverIdx].lineValue)}
              r={4}
              fill={lineColor}
              stroke="#FFFFFF"
              strokeWidth={1.5}
            />
          ) : null}
        </svg>
      </div>

      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="legend-dot" style={{ backgroundColor: barColor }} />
          <span>{barLabel}</span>
        </span>
        <span className="chart-legend-item">
          <span className="legend-dot" style={{ backgroundColor: lineColor }} />
          <span>{lineLabel}</span>
        </span>
      </div>

      {hovered ? (
        <div className="tooltip-box" style={{ left: mousePos.x + 12, top: mousePos.y - 12 }}>
          <div className="mono" style={{ fontWeight: 600, marginBottom: 4 }}>{hovered.label}</div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: "#CBD5E1" }}>{barLabel}</span>
            <span className="mono">{formatBar(hovered.barValue)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span style={{ color: "#CBD5E1" }}>{lineLabel}</span>
            <span className="mono">{formatLine(hovered.lineValue)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

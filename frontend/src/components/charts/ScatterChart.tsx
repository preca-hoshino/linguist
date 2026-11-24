import { useMemo, useState } from "react";

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

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  formatX = (v) => `${Math.round(v)}ms`,
  formatY = (v) => `${v.toFixed(1)} t/s`,
  formatSize = (v) => `${Math.round(v)} req`,
  height = 240,
}: ScatterChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const { maxX, maxY, maxSize } = useMemo(() => {
    let mx = 0;
    let my = 0;
    let ms = 0;
    for (const p of points) {
      if (p.x > mx) mx = p.x;
      if (p.y > my) my = p.y;
      if (p.size > ms) ms = p.size;
    }
    return {
      maxX: mx > 0 ? mx * 1.15 : 100,
      maxY: my > 0 ? my * 1.15 : 100,
      maxSize: ms > 0 ? ms : 1,
    };
  }, [points]);

  const svgWidth = 640;
  const padLeft = 56;
  const padRight = 24;
  const padTop = 18;
  const padBottom = 38;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const xAt = (v: number) => padLeft + (v / maxX) * plotW;
  const yAt = (v: number) => padTop + plotH - (v / maxY) * plotH;
  const rAt = (s: number) => 6 + Math.sqrt(s / maxSize) * 14;

  const active = points.find((p) => p.key === hoveredKey);

  return (
    <div>
      <div className="monitoring-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${height}`}
          className="monitoring-svg"
          role="img"
          aria-label="性能散点象限图"
          onMouseLeave={() => { setHoveredKey(null); }}
        >
          {ticks.map((t) => {
            const y = padTop + plotH * (1 - t);
            const x = padLeft + plotW * t;
            return (
              <g key={t}>
                <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="#E5E2DC" strokeDasharray="3 3" />
                <line x1={x} y1={padTop} x2={x} y2={padTop + plotH} stroke="#E5E2DC" strokeDasharray="3 3" />
                <text x={padLeft - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#64748B" className="mono">
                  {formatY(maxY * t)}
                </text>
                <text x={x} y={padTop + plotH + 15} textAnchor="middle" fontSize="10" fill="#64748B" className="mono">
                  {formatX(maxX * t)}
                </text>
              </g>
            );
          })}

          <text x={padLeft + plotW / 2} y={height - 4} textAnchor="middle" fontSize="10" fill="#64748B">
            {xLabel}
          </text>

          {points.map((p) => {
            const cx = xAt(p.x);
            const cy = yAt(p.y);
            const r = rAt(p.size);
            const isHovered = hoveredKey === p.key;
            return (
              <g key={p.key}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={p.color}
                  fillOpacity={isHovered ? 0.9 : 0.68}
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => {
                    setHoveredKey(p.key);
                    setMousePos({ x: e.clientX, y: e.clientY });
                  }}
                  onMouseMove={(e) => {
                    setMousePos({ x: e.clientX, y: e.clientY });
                  }}
                />
                <text x={cx} y={cy - r - 4} textAnchor="middle" fontSize="10" fill="#334155">
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="chart-legend">
        <span className="section-desc">纵轴：{yLabel}（越靠左上越优） · 气泡大小：请求量</span>
      </div>

      {active ? (
        <div className="tooltip-box" style={{ left: mousePos.x + 12, top: mousePos.y - 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{active.label}</div>
          <div className="mono">{xLabel}: {formatX(active.x)}</div>
          <div className="mono">{yLabel}: {formatY(active.y)}</div>
          <div className="mono">请求量: {formatSize(active.size)}</div>
        </div>
      ) : null}
    </div>
  );
}

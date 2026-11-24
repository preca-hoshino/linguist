import { useMemo, useState } from "react";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  slices: DonutSlice[];
  centerLabel?: string;
  formatValue?: (v: number) => string;
}

export function DonutChart({
  slices,
  centerLabel = "总计",
  formatValue = (v) => v.toFixed(0),
}: DonutChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const { total, arcs } = useMemo(() => {
    const sum = slices.reduce((acc, s) => acc + Math.max(0, s.value), 0);
    const radius = 56;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    const computed = slices
      .filter((s) => s.value > 0)
      .map((s) => {
        const fraction = sum > 0 ? s.value / sum : 0;
        const dash = fraction * circumference;
        const item = {
          ...s,
          fraction,
          dash,
          gap: circumference - dash,
          offset: -offset,
        };
        offset += dash;
        return item;
      });
    return { total: sum, arcs: computed };
  }, [slices]);

  const activeSlice = arcs.find((a) => a.key === hoveredKey);

  return (
    <div className="monitoring-donut-layout">
      <svg viewBox="0 0 160 160" className="monitoring-donut-svg" role="img" aria-label="环形占比图">
        <circle cx={80} cy={80} r={56} fill="none" stroke="#F3F0EC" strokeWidth={20} />
        <g transform="rotate(-90 80 80)">
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={80}
              cy={80}
              r={56}
              fill="none"
              stroke={a.color}
              strokeWidth={hoveredKey === a.key ? 24 : 20}
              strokeDasharray={`${a.dash} ${a.gap}`}
              strokeDashoffset={a.offset}
              opacity={hoveredKey !== null && hoveredKey !== a.key ? 0.35 : 1}
              style={{ cursor: "pointer", transition: "stroke-width 120ms ease, opacity 120ms ease" }}
              onMouseEnter={() => { setHoveredKey(a.key); }}
              onMouseLeave={() => { setHoveredKey(null); }}
            />
          ))}
        </g>
        <text x={80} y={76} textAnchor="middle" fontSize="11" fill="#64748B">
          {activeSlice ? activeSlice.label : centerLabel}
        </text>
        <text x={80} y={94} textAnchor="middle" fontSize="14" fontWeight="600" fill="#111827" className="mono">
          {activeSlice ? formatValue(activeSlice.value) : formatValue(total)}
        </text>
      </svg>

      <div className="monitoring-donut-legend">
        {arcs.map((a) => (
          <div
            key={a.key}
            className={`monitoring-donut-row${hoveredKey === a.key ? " active" : ""}`}
            onMouseEnter={() => { setHoveredKey(a.key); }}
            onMouseLeave={() => { setHoveredKey(null); }}
          >
            <span className="legend-dot" style={{ backgroundColor: a.color }} />
            <span className="monitoring-donut-name" title={a.label}>{a.label}</span>
            <span className="mono monitoring-donut-val">{formatValue(a.value)}</span>
            <span className="mono monitoring-donut-pct">{(a.fraction * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

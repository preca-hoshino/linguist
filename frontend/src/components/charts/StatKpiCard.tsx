export type StatTone = "default" | "green" | "blue" | "amber" | "red";

interface StatKpiCardProps {
  title: string;
  value: string;
  subValue?: string;
  helpText?: string;
  tone?: StatTone;
  compact?: boolean;
}

export function StatKpiCard({
  title,
  value,
  subValue,
  helpText,
  tone = "default",
  compact = false,
}: StatKpiCardProps) {
  return (
    <div className={`monitoring-stat-card${compact ? " compact" : ""}`}>
      <div className="monitoring-stat-head">
        <span className="monitoring-stat-title">{title}</span>
        {helpText ? (
          <span className="monitoring-help-tip" title={helpText} aria-label={helpText}>
            ?
          </span>
        ) : null}
      </div>
      <div className={`monitoring-stat-value mono tone-${tone}`}>{value}</div>
      {subValue ? <div className="monitoring-stat-sub mono">{subValue}</div> : null}
    </div>
  );
}

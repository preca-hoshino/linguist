import { formatInteger, modelColor } from "../api/client";
import type { LeaderboardItem, LeaderboardSort } from "../types/telemetry";
import { LobeIcon } from "./LobeIcon";

interface ModelLeaderboardProps {
  items: LeaderboardItem[];
  days: number;
  sort: LeaderboardSort;
  onDaysChange: (days: number) => void;
  onSortChange: (sort: LeaderboardSort) => void;
}

function metricScore(item: LeaderboardItem, sort: LeaderboardSort): number {
  switch (sort) {
    case "avg_decode_tps":
      return item.avgDecodeTps;
    case "p50_decode_tps":
      return item.p50DecodeTps;
    case "p90_decode_tps":
      return item.p90DecodeTps;
    case "avg_ttft_ms":
      return item.avgTtftMs > 0 ? 100_000 / item.avgTtftMs : 0;
  }
}

function primaryMetric(item: LeaderboardItem, sort: LeaderboardSort): { label: string; value: string; unit: string } {
  switch (sort) {
    case "avg_decode_tps":
      return { label: "Avg", value: item.avgDecodeTps.toFixed(1), unit: "tok/s" };
    case "p50_decode_tps":
      return { label: "P50", value: item.p50DecodeTps.toFixed(1), unit: "tok/s" };
    case "p90_decode_tps":
      return { label: "P90", value: item.p90DecodeTps.toFixed(1), unit: "tok/s" };
    case "avg_ttft_ms":
      return { label: "Avg TTFT", value: String(Math.round(item.avgTtftMs)), unit: "ms" };
  }
}

export function ModelLeaderboard({
  items,
  days,
  sort,
  onDaysChange,
  onSortChange,
}: ModelLeaderboardProps) {
  const maxScore = items.reduce((acc, item) => Math.max(acc, metricScore(item, sort)), 0);

  return (
    <section className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">模型速率排行榜</h2>
          <p className="section-desc">
            实测净生成速率 (<span className="mono">decode_tps</span>)、首字延迟 TTFT 与样本分布
          </p>
        </div>

        <div className="filter-pills">
          <div className="segmented-group" role="tablist" aria-label="Leaderboard time window">
            {(
              [
                [7, "7天"],
                [30, "30天"],
                [0, "全部"],
              ] as const
            ).map(([d, label]) => (
              <button
                key={d}
                type="button"
                className={`segmented-btn ${days === d ? "active" : ""}`}
                onClick={() => {
                  onDaysChange(d);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="segmented-group" role="tablist" aria-label="Leaderboard sort">
            {(
              [
                ["avg_decode_tps", "Avg tok/s"],
                ["p50_decode_tps", "P50 tok/s"],
                ["p90_decode_tps", "P90 tok/s"],
                ["avg_ttft_ms", "最快 TTFT"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segmented-btn ${sort === key ? "active" : ""}`}
                onClick={() => {
                  onSortChange(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">所选时间窗口内暂无测速样本</div>
      ) : (
        <div className="leaderboard-list">
          {items.map((item, idx) => {
            const score = metricScore(item, sort);
            const primary = primaryMetric(item, sort);
            const widthPct = maxScore > 0 ? Math.max(6, Math.min(100, (score / maxScore) * 100)) : 0;
            const barColor = modelColor(`${item.providerId}/${item.modelId}`);

            return (
              <div key={`${item.providerId}/${item.modelId}`} className="leaderboard-row">
                <div className={`rank-badge ${idx === 0 ? "top1" : ""}`}>#{idx + 1}</div>

                <div className="entity-cell">
                  <LobeIcon slug={item.modelIcon} label={item.modelName} size={22} />
                  <div className="entity-text">
                    <span className="entity-name">{item.modelName}</span>
                    <span className="code-chip">{item.modelId}</span>
                  </div>
                </div>

                <div className="entity-cell">
                  <LobeIcon slug={item.providerIcon} label={item.providerName} size={18} />
                  <span className="entity-name" style={{ fontWeight: 500 }}>
                    {item.providerName}
                  </span>
                </div>

                <div className="leaderboard-hide-sm">
                  <div className="speed-bar-track">
                    <div
                      className="speed-bar-fill"
                      style={{ width: `${widthPct.toFixed(1)}%`, backgroundColor: barColor }}
                    />
                  </div>
                </div>

                <div className="metric-col">
                  <div className="metric-primary">{primary.label} {primary.value} {primary.unit}</div>
                </div>

                <div className="metric-col">
                  <div className="metric-primary">{formatInteger(item.requestCount)}</div>
                  <div className="metric-secondary">样本</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

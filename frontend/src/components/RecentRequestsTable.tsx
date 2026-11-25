import { useState } from "react";
import { formatInteger } from "../api/client";
import type { RecentRequestItem } from "../types/telemetry";
import { billingStatus, money } from "../billing/api";
import type { BillingDashboard } from "../billing/api";
import { RequestDetails } from "../billing/RequestDetails";
import { LobeIcon } from "./LobeIcon";

interface RecentRequestsTableProps {
  items: RecentRequestItem[];
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  billing: BillingDashboard | null;
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}:${sec}`;
}

function ttftClassName(ttftMs: number): string {
  if (ttftMs <= 350) return "ttft-fast";
  if (ttftMs <= 1200) return "ttft-medium";
  return "ttft-slow";
}

export function RecentRequestsTable({
  items,
  selectedModel,
  onModelChange,
  billing,
}: RecentRequestsTableProps) {
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const costs = new Map(billing?.items.map((item) => [item.requestUid, item]) ?? []);
  const uniqueModels = Array.from(
    new Map(items.map((item) => [item.modelId, item.modelName])).entries(),
  );

  return (
    <section className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">最近请求列表 (Recent Requests)</h2>
          <p className="section-desc">实时透传请求流水、Token 分布、TTFT 与净生成速率</p>
        </div>

        <div className="filter-pills">
          <button
            type="button"
            className={`btn-control ${selectedModel === "" ? "active" : ""}`}
            onClick={() => {
              onModelChange("");
            }}
          >
            全部模型
          </button>
          {uniqueModels.slice(0, 6).map(([mid, mname]) => (
            <button
              key={mid}
              type="button"
              className={`btn-control ${selectedModel === mid ? "active" : ""}`}
              onClick={() => {
                onModelChange(selectedModel === mid ? "" : mid);
              }}
            >
              {mname}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">暂无请求日志</div>
      ) : (
        <><div className="table-scroll">
          <table className="requests-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>模型显示名</th>
                <th>模型调用名</th>
                <th>提供商</th>
                <th>Token 统计 (输入 / 输出 / 缓存)</th>
                <th>费用</th>
                <th style={{ textAlign: "right" }}>耗时 (TTFT)</th>
                <th style={{ textAlign: "right" }}>速率 (tok/s)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const showCallSub = row.callModelId !== row.modelId;
                const cost = costs.get(row.requestUid);
                return (
                  <tr key={row.requestUid}>
                    <td className="mono" style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                      <div>{formatShortTime(row.createdAt)}</div>
                      <div style={{ fontSize: 10, color: "var(--ink-muted)" }}>
                        HTTP {row.statusCode}
                        {row.attemptIndex > 1 ? ` · retry #${row.attemptIndex}` : ""}
                      </div>
                    </td>

                    <td>
                      <div className="entity-cell">
                        <LobeIcon slug={row.modelIcon} label={row.modelName} size={20} />
                        <span className="entity-name">{row.modelName}</span>
                      </div>
                    </td>

                    <td>
                      <div className="entity-text">
                        <span className="code-chip">{row.modelId}</span>
                        {showCallSub ? (
                          <span
                            className="mono"
                            style={{ fontSize: 10, color: "var(--ink-muted)" }}
                          >
                            call: {row.callModelId} · {row.projectName}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: "var(--ink-muted)" }}>
                            {row.projectName}
                          </span>
                        )}
                      </div>
                    </td>

                    <td>
                      <div className="entity-cell">
                        <LobeIcon slug={row.providerIcon} label={row.providerName} size={18} />
                        <span style={{ fontSize: 13 }}>{row.providerName}</span>
                      </div>
                    </td>

                    <td>
                      <div className="token-pills">
                        <span className="token-pill">
                          <span className="token-pill-tag">入</span>
                          {formatInteger(row.inputTokens)}
                        </span>
                        <span className="token-pill">
                          <span className="token-pill-tag">出</span>
                          {formatInteger(row.outputTokens)}
                        </span>
                        <span className="token-pill">
                          <span className="token-pill-tag">缓</span>
                          {formatInteger(row.cacheReadTokens)}
                        </span>
                        {row.cacheCreationTokens > 0 ? (
                          <span className="token-pill">
                            <span className="token-pill-tag">缓写</span>
                            {formatInteger(row.cacheCreationTokens)}
                          </span>
                        ) : null}
                        {row.reasoningTokens > 0 ? (
                          <span className="token-pill">
                            <span className="token-pill-tag">思</span>
                            {formatInteger(row.reasoningTokens)}
                          </span>
                        ) : null}
                        {Object.entries(row.extraTokens).map(([key, val]) => (
                          <span key={key} className="token-pill">
                            <span className="token-pill-tag">{key}</span>
                            {formatInteger(val)}
                          </span>
                        ))}
                      </div>
                    </td>

                    <td className="mono">
                      {cost ? <button className="catalog-link billing-link-button" type="button" onClick={() => { setSelectedRequest(row.requestUid); }} aria-label={`查看 ${row.modelName} 的计价明细`}>
                        {cost.amount === null ? billingStatus(cost.billingStatus) : `${cost.billingStatus === "estimated" ? "估算 " : ""}${money(cost.amount, cost.currency)}`}
                      </button> : "—"}
                      {cost?.convertedAmount && billing?.displayCurrency && cost.currency !== billing.displayCurrency ? <div>≈ {money(cost.convertedAmount, billing.displayCurrency)}</div> : null}
                    </td>

                    <td className="metric-col">
                      <div className={`metric-primary ${ttftClassName(row.ttftMs)}`}>
                        {Math.round(row.ttftMs)} ms
                      </div>
                      <div className="metric-secondary">
                        总 {(row.totalDurationMs / 1000).toFixed(2)}s
                      </div>
                    </td>

                    <td
                      className="metric-col"
                      title={`E2E: ${row.e2eTps.toFixed(1)} tok/s · Rule: ${row.routeRuleId} · Attempt #${row.attemptIndex}`}
                    >
                      <div className="metric-primary">{row.decodeTps.toFixed(1)} tok/s</div>
                      <div className="metric-secondary">E2E {row.e2eTps.toFixed(1)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>{selectedRequest && billing && costs.has(selectedRequest) ? <RequestDetails key={selectedRequest} requestUid={selectedRequest} onClose={() => { setSelectedRequest(null); }} /> : null}</>
      )}
    </section>
  );
}

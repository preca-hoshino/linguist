import { useState } from "react";
import { formatInteger } from "../api/client";
import type { FilterEntityItem, RecentRequestItem } from "../types/telemetry";
import { billingStatus, money } from "../billing/api";
import { RequestDetails } from "../billing/RequestDetails";
import { LobeIcon } from "./LobeIcon";

interface RecentRequestsTableProps {
  items: RecentRequestItem[];
  models: FilterEntityItem[];
  selectedModel: string;
  selectedStatus: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  displayCurrency: string | null;
  onModelChange: (modelId: string) => void;
  onStatusChange: (status: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
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
  models,
  selectedModel,
  selectedStatus,
  page,
  pageSize,
  total,
  totalPages,
  hasNext,
  displayCurrency,
  onModelChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
}: RecentRequestsTableProps) {
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);

  return (
    <section className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">请求流水日志 (Request Logs)</h2>
          <p className="section-desc">
            共 {formatInteger(total)} 条记录 · 实时透传请求流水、Token 分布、费用明细与速率指标
          </p>
        </div>

        <div className="filter-pills">
          <select
            aria-label="筛选模型"
            className="select-control"
            value={selectedModel}
            onChange={(e) => {
              onModelChange(e.target.value);
            }}
          >
            <option value="">全部模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>

          <select
            aria-label="筛选状态"
            className="select-control"
            value={selectedStatus}
            onChange={(e) => {
              onStatusChange(e.target.value);
            }}
          >
            <option value="">全部状态</option>
            <option value="success">仅成功 (&lt;400)</option>
            <option value="error">仅异常 (&gt;=400)</option>
          </select>

          <select
            aria-label="每页条数"
            className="select-control"
            value={pageSize}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value));
            }}
          >
            <option value={20}>20 条/页</option>
            <option value={50}>50 条/页</option>
            <option value={100}>100 条/页</option>
          </select>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">暂无匹配请求日志</div>
      ) : (
        <>
          <div className="table-scroll">
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
                  const hasCostLabel = row.billingAmount !== null || row.billingStatus !== null;
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
                        {hasCostLabel ? (
                          <button
                            className="catalog-link billing-link-button"
                            type="button"
                            onClick={() => {
                              setSelectedRequest(row.requestUid);
                            }}
                            aria-label={`查看 ${row.modelName} 的计价明细`}
                          >
                            {row.billingAmount === null
                              ? billingStatus(row.billingStatus)
                              : `${row.billingStatus === "estimated" ? "估算 " : ""}${money(row.billingAmount, row.billingCurrency)}`}
                          </button>
                        ) : (
                          "—"
                        )}
                        {row.billingConvertedAmount &&
                        displayCurrency &&
                        row.billingCurrency !== displayCurrency ? (
                          <div>≈ {money(row.billingConvertedAmount, displayCurrency)}</div>
                        ) : null}
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
          </div>
          {selectedRequest ? (
            <RequestDetails
              key={selectedRequest}
              requestUid={selectedRequest}
              onClose={() => {
                setSelectedRequest(null);
              }}
            />
          ) : null}
        </>
      )}

      {total > 0 ? (
        <nav className="catalog-pagination" aria-label="日志分页">
          <button
            className="btn-control"
            type="button"
            disabled={page <= 1}
            onClick={() => {
              onPageChange(1);
            }}
          >
            首页
          </button>
          <button
            className="btn-control"
            type="button"
            disabled={page <= 1}
            onClick={() => {
              onPageChange(page - 1);
            }}
          >
            上一页
          </button>
          <span>
            第 {page} / {totalPages} 页 · 共 {formatInteger(total)} 条
          </span>
          <button
            className="btn-control"
            type="button"
            disabled={!hasNext}
            onClick={() => {
              onPageChange(page + 1);
            }}
          >
            下一页
          </button>
          <button
            className="btn-control"
            type="button"
            disabled={!hasNext}
            onClick={() => {
              onPageChange(totalPages);
            }}
          >
            末页
          </button>
        </nav>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from "react";
import { billingError, billingStatus, getBillingAttempts, money } from "./api";
import type { BillingAttempt, BillingAttemptGroup } from "./api";

function detailValue(details: Record<string, unknown> | null, key: string): string {
  const value = details?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function tierDetails(details: Record<string, unknown> | null): Record<string, unknown> | null {
  const tier = details?.tier;
  return typeof tier === "object" && tier !== null && !Array.isArray(tier) ? tier as Record<string, unknown> : null;
}

function AttemptDetails({ item }: { item: BillingAttempt }) {
  const tier = tierDetails(item.details);
  return <div className="billing-details" role="region" aria-label="计价明细">
    <h3>尝试 {item.attemptIndex} · {item.providerName} / {item.modelName}</h3>
    <p>HTTP {item.statusCode} · {item.amount === null ? billingStatus(item.billingStatus) : `${item.billingStatus === "estimated" ? "估算 " : ""}${money(item.amount, item.currency)}`}</p>
    {item.billingStatus === "estimated" && item.details?.source ? <p>估算依据：{detailValue(item.details, "source")}</p> : null}
    {item.details?.assumedMissingWriteZero === true ? <p>上游未提供缓存写入量，暂按 0 估算。</p> : null}
    {tier ? <p>价格分档：{detailValue(tier, "minInputTokens")} Token 起 · 单位 {item.currency} / 百万 Token</p> : null}
    {tier ? <div className="billing-breakdown">
      {([["普通输入", "inputTokens", "inputAmount", "inputPrice"], ["输出", "outputTokens", "outputAmount", "outputPrice"], ["缓存读取", "cacheReadTokens", "cacheReadAmount", "cacheReadPrice"], ["缓存写入", "cacheWriteTokens", "cacheWriteAmount", "cacheWritePrice"]] as const).map(([label, tokens, amount, price]) => (
        <div key={label}><strong>{label}</strong><span>{detailValue(item.details, tokens)} Token</span><span>单价：{detailValue(tier, price) === "—" && (price === "cacheReadPrice" || (price === "cacheWritePrice" && tier.cacheWriteMode === "input")) ? detailValue(tier, "inputPrice") : detailValue(tier, price)}</span><span>{money(detailValue(item.details, amount) === "—" ? null : detailValue(item.details, amount), item.currency)}</span></div>
      ))}
    </div> : null}
  </div>;
}

export function RequestDetails({ requestUid, onClose }: { requestUid: string; onClose: () => void }) {
  const [result, setResult] = useState<{ page: number; group: BillingAttemptGroup } | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const group = result?.page === page ? result.group : null;
  useEffect(() => {
    const controller = new AbortController();
    void getBillingAttempts(requestUid, page, controller.signal).then((value) => { setResult({ page, group: value }); setError(""); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setResult(null); setError(billingError(reason)); } });
    return () => { controller.abort(); };
  }, [requestUid, page]);
  return <div className="billing-details" role="region" aria-label="请求计价明细">
    <div className="section-header"><h3>请求计价明细</h3><button className="btn-control" type="button" onClick={onClose}>关闭</button></div>
    {error ? <div className="error-banner" role="alert">{error}</div> : null}
    {!group && !error ? <p role="status">加载中…</p> : null}
    {group ? <><p className="mono">{group.requestUid}</p><p>已计价：{group.totals.length ? group.totals.map((total) => money(total.amount, total.currency)).join(" · ") : "—"} · 未计价：{group.unpriced}</p>
      {group.items.map((attempt) => <AttemptDetails key={attempt.requestUid} item={attempt} />)}
      {page > 1 || group.hasNext ? <nav className="catalog-pagination" aria-label="尝试分页"><button className="btn-control" type="button" disabled={page === 1} onClick={() => { setPage(page - 1); }}>上一页</button><span>第 {page} 页</span><button className="btn-control" type="button" disabled={!group.hasNext} onClick={() => { setPage(page + 1); }}>下一页</button></nav> : null}
    </> : null}
  </div>;
}

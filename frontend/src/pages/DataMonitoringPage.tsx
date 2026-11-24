import { useCallback, useEffect, useRef, useState } from "react";
import { modelColor } from "../api/client";
import {
  fetchCostMonitoring,
  fetchPerformanceMonitoring,
  fetchRoutingMonitoring,
  fetchTrafficMonitoring,
  formatCompactNumber,
  formatMoney,
  formatMs,
} from "../api/monitoring";
import { ChartCard } from "../components/charts/ChartCard";
import { ComboChart } from "../components/charts/ComboChart";
import { DonutChart } from "../components/charts/DonutChart";
import { HorizontalBarChart } from "../components/charts/HorizontalBarChart";
import { LineAreaChart } from "../components/charts/LineAreaChart";
import { ScatterChart } from "../components/charts/ScatterChart";
import { StackedBarChart } from "../components/charts/StackedBarChart";
import type {
  CostMonitoringResponse,
  GranularityKey,
  MonitoringDimension,
  MonitoringMeta,
  PerformanceMonitoringResponse,
  RoutingMonitoringResponse,
  TimeRangeKey,
  TrafficMonitoringResponse,
} from "../types/monitoring";

const DIMENSIONS: { key: MonitoringDimension; label: string }[] = [
  { key: "traffic", label: "流量" },
  { key: "performance", label: "性能" },
  { key: "routing", label: "路由" },
  { key: "cost", label: "成本" },
];

const TIME_RANGES: { key: TimeRangeKey; label: string }[] = [
  { key: "1h", label: "1小时" },
  { key: "6h", label: "6小时" },
  { key: "24h", label: "24小时" },
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { key: "90d", label: "90天" },
];

const GRANULARITIES: { key: GranularityKey; label: string }[] = [
  { key: "auto", label: "自动" },
  { key: "minute", label: "分钟" },
  { key: "hour", label: "小时" },
  { key: "day", label: "天" },
];

export function DataMonitoringPage() {
  const [dimension, setDimension] = useState<MonitoringDimension>("traffic");
  const [range, setRange] = useState<TimeRangeKey>("24h");
  const [granularity, setGranularity] = useState<GranularityKey>("auto");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [trafficData, setTrafficData] = useState<TrafficMonitoringResponse | null>(null);
  const [perfData, setPerfData] = useState<PerformanceMonitoringResponse | null>(null);
  const [routingData, setRoutingData] = useState<RoutingMonitoringResponse | null>(null);
  const [costData, setCostData] = useState<CostMonitoringResponse | null>(null);

  const [usageGroupBy, setUsageGroupBy] = useState<"model" | "project">("model");
  const [usageMetric, setUsageMetric] = useState<"totalTokens" | "requestCount">("totalTokens");
  const [costRankBy, setCostRankBy] = useState<"project" | "model">("project");

  const pending = useRef<AbortController | null>(null);

  const loadDimension = useCallback(
    async (skipIfPending = false) => {
      if (skipIfPending && pending.current) return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const { signal } = controller;
      setIsRefreshing(true);

      const params = {
        range,
        granularity,
        projectId: selectedProject,
        providerId: selectedProvider,
        modelId: selectedModel,
      };

      try {
        if (dimension === "traffic") {
          const resp = await fetchTrafficMonitoring(params, signal);
          if (!signal.aborted) setTrafficData(resp);
        } else if (dimension === "performance") {
          const resp = await fetchPerformanceMonitoring(params, signal);
          if (!signal.aborted) setPerfData(resp);
        } else if (dimension === "routing") {
          const resp = await fetchRoutingMonitoring(params, signal);
          if (!signal.aborted) setRoutingData(resp);
        } else {
          const resp = await fetchCostMonitoring(params, signal);
          if (!signal.aborted) setCostData(resp);
        }
        if (!signal.aborted) {
          setErrorMsg(null);
          setLastUpdated(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      } catch (err) {
        if (!signal.aborted) {
          setErrorMsg(err instanceof Error ? err.message : "监控数据加载失败");
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          if (!signal.aborted) setIsRefreshing(false);
        }
      }
    },
    [dimension, range, granularity, selectedProject, selectedProvider, selectedModel],
  );

  useEffect(() => {
    void loadDimension();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadDimension]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadDimension(true);
    }, 5000);
    return () => { window.clearInterval(timer); };
  }, [autoRefresh, loadDimension]);

  const activeMeta: MonitoringMeta | undefined =
    (dimension === "traffic" ? trafficData?.meta : undefined) ??
    (dimension === "performance" ? perfData?.meta : undefined) ??
    (dimension === "routing" ? routingData?.meta : undefined) ??
    costData?.meta ??
    trafficData?.meta ??
    perfData?.meta ??
    routingData?.meta;

  const projects = activeMeta?.projects ?? [];
  const providers = activeMeta?.providers ?? [];
  const models = activeMeta?.models ?? [];

  return (
    <div className="app-shell">
      <header className="header-bar">
        <div className="header-inner">
          <div className="brand-group">
            <div className="brand-mark">DM</div>
            <div>
              <h1 className="brand-title">数据监控</h1>
              <p className="brand-subtitle">
                多维度实时指标监控面板
                {activeMeta ? ` · 粒度: ${activeMeta.granularity} (${activeMeta.timezone})` : ""}
                {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
              </p>
            </div>
          </div>

          <div className="header-controls">
            <div className="segmented-group" role="group" aria-label="时间范围">
              {TIME_RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`segmented-btn${range === item.key ? " active" : ""}`}
                  onClick={() => { setRange(item.key); }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <select
              aria-label="时间粒度"
              className="select-control"
              value={granularity}
              onChange={(e) => { setGranularity(e.target.value as GranularityKey); }}
            >
              {GRANULARITIES.map((g) => (
                <option key={g.key} value={g.key}>粒度: {g.label}</option>
              ))}
            </select>

            <select
              aria-label="按项目筛选"
              className="select-control"
              value={selectedProject}
              onChange={(e) => { setSelectedProject(e.target.value); }}
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>项目: {p.name}</option>
              ))}
            </select>

            <select
              aria-label="按供应商筛选"
              className="select-control"
              value={selectedProvider}
              onChange={(e) => { setSelectedProvider(e.target.value); }}
            >
              <option value="">全部供应商</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>供应商: {p.name}</option>
              ))}
            </select>

            <select
              aria-label="按模型筛选"
              className="select-control"
              value={selectedModel}
              onChange={(e) => { setSelectedModel(e.target.value); }}
            >
              <option value="">全部模型</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>模型: {m.name}</option>
              ))}
            </select>

            <button
              type="button"
              className={`btn-control${autoRefresh ? " active" : ""}`}
              onClick={() => { setAutoRefresh((v) => !v); }}
            >
              <span className={`live-dot${autoRefresh ? "" : " paused"}`} />
              {autoRefresh ? "5s 刷新" : "已暂停"}
            </button>

            <button
              type="button"
              className="btn-control"
              onClick={() => { void loadDimension(); }}
              disabled={isRefreshing}
            >
              {isRefreshing ? "刷新中..." : "刷新"}
            </button>
          </div>
        </div>
      </header>

      <main className="page-container" id="main-content" tabIndex={-1}>
        <div className="monitoring-tabs" role="tablist" aria-label="监控维度">
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={dimension === d.key}
              className={`monitoring-tab${dimension === d.key ? " active" : ""}`}
              onClick={() => { setDimension(d.key); }}
            >
              {d.label}
            </button>
          ))}
        </div>

        {errorMsg ? <div className="error-banner">监控数据加载失败：{errorMsg}</div> : null}

        {dimension === "traffic" ? (
          <TrafficView
            data={trafficData}
            loading={isRefreshing && !trafficData}
            groupBy={usageGroupBy}
            metric={usageMetric}
            onGroupByChange={setUsageGroupBy}
            onMetricChange={setUsageMetric}
          />
        ) : null}

        {dimension === "performance" ? (
          <PerformanceView data={perfData} loading={isRefreshing && !perfData} />
        ) : null}

        {dimension === "routing" ? (
          <RoutingView data={routingData} loading={isRefreshing && !routingData} />
        ) : null}

        {dimension === "cost" ? (
          <CostView
            data={costData}
            loading={isRefreshing && !costData}
            rankBy={costRankBy}
            onRankByChange={setCostRankBy}
          />
        ) : null}
      </main>
    </div>
  );
}

function TrafficView({
  data,
  loading,
  groupBy,
  metric,
  onGroupByChange,
  onMetricChange,
}: {
  data: TrafficMonitoringResponse | null;
  loading: boolean;
  groupBy: "model" | "project";
  metric: "totalTokens" | "requestCount";
  onGroupByChange: (v: "model" | "project") => void;
  onMetricChange: (v: "totalTokens" | "requestCount") => void;
}) {
  const buckets = data?.buckets ?? [];
  const hasTraffic = buckets.some((b) => b.totalRequests > 0);
  const distItems = groupBy === "model" ? (data?.distributionByModel ?? []) : (data?.distributionByProject ?? []);

  return (
    <div className="monitoring-grid">
      <ChartCard title="请求量趋势" description="总请求、成功请求与异常请求数变化" loading={loading} empty={!hasTraffic}>
        <LineAreaChart
          data={buckets.map((b) => ({
            label: b.label,
            values: {
              total: b.totalRequests,
              success: b.successRequests,
              error: b.errorRequests,
            },
          }))}
          series={[
            { key: "total", label: "总请求", color: "#4B7FFF", area: true },
            { key: "success", label: "成功", color: "#22C55E" },
            { key: "error", label: "异常", color: "#EF4444" },
          ]}
          formatValue={formatCompactNumber}
        />
      </ChartCard>

      <ChartCard title="Token 消耗构成" description="输入、输出、缓存读取、缓存写入与推理思考堆叠趋势" loading={loading} empty={!hasTraffic}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: {
              input: b.inputTokens,
              output: b.outputTokens,
              cacheRead: b.cacheReadTokens,
              cacheWrite: b.cacheCreationTokens,
              reasoning: b.reasoningTokens,
            },
          }))}
          series={[
            { key: "input", label: "输入", color: "#4B7FFF" },
            { key: "output", label: "输出", color: "#14B8A6" },
            { key: "cacheRead", label: "缓存读取", color: "#6366F1" },
            { key: "cacheWrite", label: "缓存写入", color: "#0EA5E9" },
            { key: "reasoning", label: "推理思考", color: "#F59E0B" },
          ]}
          formatValue={formatCompactNumber}
        />
      </ChartCard>

      <ChartCard title="缓存命中量与命中率" description="缓存读取 Token 量（柱）与命中率百分比（折线）" loading={loading} empty={!hasTraffic}>
        <ComboChart
          data={buckets.map((b) => ({
            label: b.label,
            barValue: b.cacheReadTokens,
            lineValue: b.cacheHitRate,
          }))}
          barLabel="缓存读取 Token"
          lineLabel="缓存命中率"
          formatBar={formatCompactNumber}
          formatLine={(v) => `${v.toFixed(1)}%`}
        />
      </ChartCard>

      <ChartCard
        title="用量占比分布"
        description="Top 6 实体与其余汇总占比"
        loading={loading}
        empty={distItems.length === 0}
        controls={(
          <>
            <div className="segmented-group">
              <button type="button" className={`segmented-btn${groupBy === "model" ? " active" : ""}`} onClick={() => { onGroupByChange("model"); }}>按模型</button>
              <button type="button" className={`segmented-btn${groupBy === "project" ? " active" : ""}`} onClick={() => { onGroupByChange("project"); }}>按项目</button>
            </div>
            <div className="segmented-group">
              <button type="button" className={`segmented-btn${metric === "totalTokens" ? " active" : ""}`} onClick={() => { onMetricChange("totalTokens"); }}>Token</button>
              <button type="button" className={`segmented-btn${metric === "requestCount" ? " active" : ""}`} onClick={() => { onMetricChange("requestCount"); }}>请求数</button>
            </div>
          </>
        )}
      >
        <DonutChart
          slices={distItems.map((s) => ({
            key: s.id,
            label: s.name,
            value: s[metric],
            color: s.id === "__other__" ? "#94A3B8" : modelColor(s.id),
          }))}
          centerLabel={metric === "totalTokens" ? "总 Token" : "总请求"}
          formatValue={formatCompactNumber}
        />
      </ChartCard>
    </div>
  );
}

function PerformanceView({
  data,
  loading,
}: {
  data: PerformanceMonitoringResponse | null;
  loading: boolean;
}) {
  const buckets = data?.buckets ?? [];
  const quadrant = data?.modelQuadrant ?? [];
  const hasPerf = buckets.some((b) => b.ttftP50 > 0 || b.decodeTpsAvg > 0);

  return (
    <div className="monitoring-grid">
      <ChartCard title="首字延迟 TTFT 分位数" description="P50 / P90 / P99 首字响应耗时趋势（ms）" loading={loading} empty={!hasPerf}>
        <LineAreaChart
          data={buckets.map((b) => ({
            label: b.label,
            values: { p50: b.ttftP50, p90: b.ttftP90, p99: b.ttftP99 },
          }))}
          series={[
            { key: "p50", label: "P50 TTFT", color: "#14B8A6" },
            { key: "p90", label: "P90 TTFT", color: "#4B7FFF" },
            { key: "p99", label: "P99 TTFT", color: "#EF4444", dashed: true },
          ]}
          formatValue={formatMs}
        />
      </ChartCard>

      <ChartCard title="生成速度 Decode TPS 分位数" description="均值 / P50 / P90 输出吞吐速率（tokens/s）" loading={loading} empty={!hasPerf}>
        <LineAreaChart
          data={buckets.map((b) => ({
            label: b.label,
            values: { avg: b.decodeTpsAvg, p50: b.decodeTpsP50, p90: b.decodeTpsP90 },
          }))}
          series={[
            { key: "avg", label: "Avg TPS", color: "#4B7FFF", area: true },
            { key: "p50", label: "P50 TPS", color: "#14B8A6" },
            { key: "p90", label: "P90 TPS", color: "#6366F1" },
          ]}
          formatValue={(v) => `${v.toFixed(1)} t/s`}
        />
      </ChartCard>

      <ChartCard title="端到端耗时拆解" description="首字等待耗时与持续生成耗时堆叠趋势" loading={loading} empty={!hasPerf}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: { ttft: b.avgTtftMs, generation: b.avgGenerationMs },
          }))}
          series={[
            { key: "ttft", label: "首字等待 (TTFT)", color: "#F59E0B" },
            { key: "generation", label: "持续生成耗时", color: "#4B7FFF" },
          ]}
          formatValue={formatMs}
        />
      </ChartCard>

      <ChartCard title="模型性能象限对比" description="平均首字延迟（横轴）与生成速度（纵轴）散点分布" loading={loading} empty={quadrant.length === 0}>
        <ScatterChart
          points={quadrant.map((q) => ({
            key: `${q.providerId}/${q.modelId}`,
            label: q.modelName,
            x: q.avgTtftMs,
            y: q.avgDecodeTps,
            size: q.requestCount,
            color: modelColor(`${q.providerId}/${q.modelId}`),
          }))}
          xLabel="平均 TTFT (ms)"
          yLabel="平均 Decode TPS"
        />
      </ChartCard>
    </div>
  );
}

function RoutingView({
  data,
  loading,
}: {
  data: RoutingMonitoringResponse | null;
  loading: boolean;
}) {
  const buckets = data?.buckets ?? [];
  const ruleKeys = data?.ruleSeriesKeys ?? [];
  const providerStats = data?.providerStats ?? [];
  const finishReasons = data?.finishReasons ?? [];
  const streamSplit = data?.streamSplit ?? { streamCount: 0, nonStreamCount: 0 };
  const hasRouting = buckets.some((b) => b.status2xx + b.status4xx + b.status5xx + b.statusOther > 0);

  return (
    <div className="monitoring-grid">
      <ChartCard title="路由规则分流趋势" description="Top 5 路由规则命中量与其余规则汇总" loading={loading} empty={!hasRouting || ruleKeys.length === 0}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: b.ruleCounts,
          }))}
          series={ruleKeys.map((k) => ({
            key: k,
            label: k,
            color: k === "其他" ? "#94A3B8" : modelColor(k),
          }))}
          formatValue={formatCompactNumber}
        />
      </ChartCard>

      <ChartCard title="供应商承接量与成功率" description="各供应商请求承接量（柱）与成功率（折线）" loading={loading} empty={providerStats.length === 0}>
        <ComboChart
          data={providerStats.map((p) => ({
            label: p.providerName,
            barValue: p.requestCount,
            lineValue: p.successRate,
          }))}
          barLabel="承接请求数"
          lineLabel="成功率"
          barColor="#4B7FFF"
          lineColor="#22C55E"
          formatBar={formatCompactNumber}
          formatLine={(v) => `${v.toFixed(1)}%`}
        />
      </ChartCard>

      <ChartCard title="重试与 Fallback 趋势" description="首次直连成功、重试/Fallback 成功与最终失败数" loading={loading} empty={!hasRouting}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: {
              firstTry: b.firstTrySuccess,
              retryOk: b.retrySuccess,
              failed: b.finalError,
            },
          }))}
          series={[
            { key: "firstTry", label: "首次直连成功", color: "#22C55E" },
            { key: "retryOk", label: "重试/Fallback成功", color: "#F59E0B" },
            { key: "failed", label: "最终失败", color: "#EF4444" },
          ]}
          formatValue={formatCompactNumber}
        />
      </ChartCard>

      <ChartCard title="状态码趋势与结束原因" description="HTTP 状态码分布及 finish_reason / 流式占比" loading={loading} empty={!hasRouting}>
        <div className="monitoring-split-stack">
          <StackedBarChart
            height={175}
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                s2xx: b.status2xx,
                s4xx: b.status4xx,
                s5xx: b.status5xx,
                sOther: b.statusOther,
              },
            }))}
            series={[
              { key: "s2xx", label: "2xx", color: "#22C55E" },
              { key: "s4xx", label: "4xx", color: "#F59E0B" },
              { key: "s5xx", label: "5xx", color: "#EF4444" },
              { key: "sOther", label: "其他", color: "#94A3B8" },
            ]}
            formatValue={formatCompactNumber}
          />
          <DonutChart
            slices={[
              ...finishReasons.map((r) => ({
                key: r.name,
                label: `原因: ${r.name}`,
                value: r.count,
                color: modelColor(`reason-${r.name}`),
              })),
              ...(streamSplit.streamCount + streamSplit.nonStreamCount > 0
                ? [{
                    key: "__stream_info",
                    label: `流式请求 (${streamSplit.streamCount}) / 非流式 (${streamSplit.nonStreamCount})`,
                    value: 0,
                    color: "#CBD5E1",
                  }]
                : []),
            ]}
            centerLabel="结束原因"
            formatValue={formatCompactNumber}
          />
        </div>
      </ChartCard>
    </div>
  );
}

function CostView({
  data,
  loading,
  rankBy,
  onRankByChange,
}: {
  data: CostMonitoringResponse | null;
  loading: boolean;
  rankBy: "project" | "model";
  onRankByChange: (v: "project" | "model") => void;
}) {
  const buckets = data?.buckets ?? [];
  const seriesKeys = data?.seriesKeys ?? [];
  const currency = data?.currency ?? null;
  const rankItems = rankBy === "project" ? (data?.rankByProject ?? []) : (data?.rankByModel ?? []);
  const hasCost = buckets.some((b) => b.totalAmount > 0);
  const fmtCost = (v: number) => formatMoney(v, currency);

  return (
    <div className="monitoring-grid">
      <ChartCard title="消费金额趋势" description={`按模型分色堆叠（${currency ?? "原币种"}）`} loading={loading} empty={!hasCost || seriesKeys.length === 0}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: b.byModel,
          }))}
          series={seriesKeys.map((s) => ({
            key: s.key,
            label: s.name,
            color: s.key === "__other__" ? "#94A3B8" : modelColor(s.key),
          }))}
          formatValue={fmtCost}
        />
      </ChartCard>

      <ChartCard title="费用构成拆解" description="输入费用、输出费用、缓存读取与写入费用堆叠" loading={loading} empty={!hasCost}>
        <StackedBarChart
          data={buckets.map((b) => ({
            label: b.label,
            values: {
              input: b.inputAmount,
              output: b.outputAmount,
              cacheRead: b.cacheReadAmount,
              cacheWrite: b.cacheWriteAmount,
            },
          }))}
          series={[
            { key: "input", label: "输入费用", color: "#4B7FFF" },
            { key: "output", label: "输出费用", color: "#14B8A6" },
            { key: "cacheRead", label: "缓存读取费", color: "#6366F1" },
            { key: "cacheWrite", label: "缓存写入费", color: "#F59E0B" },
          ]}
          formatValue={fmtCost}
        />
      </ChartCard>

      <ChartCard
        title="消费排行"
        description="按项目或模型统计总消费与未定价请求数"
        loading={loading}
        empty={rankItems.length === 0}
        controls={(
          <div className="segmented-group">
            <button type="button" className={`segmented-btn${rankBy === "project" ? " active" : ""}`} onClick={() => { onRankByChange("project"); }}>按项目</button>
            <button type="button" className={`segmented-btn${rankBy === "model" ? " active" : ""}`} onClick={() => { onRankByChange("model"); }}>按模型</button>
          </div>
        )}
      >
        <HorizontalBarChart
          items={rankItems.map((item) => ({
            key: item.id,
            label: item.name,
            value: item.amount,
            subLabel: item.unpricedCount > 0 ? `${item.unpricedCount} 未定价` : `${item.requestCount} 次`,
            color: modelColor(item.id),
          }))}
          formatValue={fmtCost}
        />
      </ChartCard>

      <ChartCard title="单位效能趋势" description="每百万 Token 综合单价与单次请求平均成本" loading={loading} empty={!hasCost}>
        <LineAreaChart
          data={buckets.map((b) => ({
            label: b.label,
            values: {
              per1m: b.costPer1mTokens,
              perReq: b.avgCostPerRequest,
            },
          }))}
          series={[
            { key: "per1m", label: "每 1M Token 成本", color: "#4B7FFF", area: true },
            { key: "perReq", label: "单次请求均价", color: "#F59E0B" },
          ]}
          formatValue={fmtCost}
        />
      </ChartCard>
    </div>
  );
}

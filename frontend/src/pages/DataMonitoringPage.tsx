import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCostMonitoring,
  fetchErrorsMonitoring,
  fetchPerformanceMonitoring,
  fetchRoutingMonitoring,
  fetchRuntimeMonitoring,
  fetchTrafficMonitoring,
} from "../api/monitoring";
import { CostView } from "../components/monitoring/CostView";
import { ErrorsView } from "../components/monitoring/ErrorsView";
import { PerformanceView } from "../components/monitoring/PerformanceView";
import { RoutingView } from "../components/monitoring/RoutingView";
import { RuntimeView } from "../components/monitoring/RuntimeView";
import { UsageView } from "../components/monitoring/UsageView";
import type {
  CostMonitoringResponse,
  ErrorsMonitoringResponse,
  GranularityKey,
  MonitoringDimension,
  MonitoringMeta,
  PerformanceMonitoringResponse,
  RoutingMonitoringResponse,
  RuntimeMonitoringResponse,
  RuntimeWindowKey,
  StreamModeKey,
  TimeRangeKey,
  TrafficMonitoringResponse,
} from "../types/monitoring";

const DIMENSIONS: { key: MonitoringDimension; label: string }[] = [
  { key: "usage", label: "用量" },
  { key: "performance", label: "性能" },
  { key: "routing", label: "路由" },
  { key: "errors", label: "异常" },
  { key: "cost", label: "成本" },
  { key: "runtime", label: "运行时" },
];

const TIME_RANGES: { key: TimeRangeKey; label: string }[] = [
  { key: "1h", label: "1小时" },
  { key: "6h", label: "6小时" },
  { key: "24h", label: "24小时" },
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { key: "90d", label: "90天" },
];

const RUNTIME_WINDOWS: { key: RuntimeWindowKey; label: string }[] = [
  { key: "5m", label: "5分钟" },
  { key: "15m", label: "15分钟" },
  { key: "1h", label: "1小时" },
  { key: "6h", label: "6小时" },
  { key: "24h", label: "24小时" },
];

const GRANULARITIES: { key: GranularityKey; label: string }[] = [
  { key: "auto", label: "自动" },
  { key: "minute", label: "分钟" },
  { key: "hour", label: "小时" },
  { key: "day", label: "天" },
];

export function DataMonitoringPage() {
  const [dimension, setDimension] = useState<MonitoringDimension>("usage");
  const [range, setRange] = useState<TimeRangeKey>("24h");
  const [granularity, setGranularity] = useState<GranularityKey>("auto");
  const [runtimeWindow, setRuntimeWindow] = useState<RuntimeWindowKey>("15m");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [streamMode, setStreamMode] = useState<StreamModeKey>("all");

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [usageData, setUsageData] = useState<TrafficMonitoringResponse | null>(null);
  const [perfData, setPerfData] = useState<PerformanceMonitoringResponse | null>(null);
  const [routingData, setRoutingData] = useState<RoutingMonitoringResponse | null>(null);
  const [errorsData, setErrorsData] = useState<ErrorsMonitoringResponse | null>(null);
  const [costData, setCostData] = useState<CostMonitoringResponse | null>(null);
  const [runtimeData, setRuntimeData] = useState<RuntimeMonitoringResponse | null>(null);

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
        streamMode,
      };

      try {
        if (dimension === "usage") {
          const resp = await fetchTrafficMonitoring(params, signal);
          if (!signal.aborted) setUsageData(resp);
        } else if (dimension === "performance") {
          const resp = await fetchPerformanceMonitoring(params, signal);
          if (!signal.aborted) setPerfData(resp);
        } else if (dimension === "routing") {
          const resp = await fetchRoutingMonitoring(params, signal);
          if (!signal.aborted) setRoutingData(resp);
        } else if (dimension === "errors") {
          const resp = await fetchErrorsMonitoring(params, signal);
          if (!signal.aborted) setErrorsData(resp);
        } else if (dimension === "cost") {
          const resp = await fetchCostMonitoring(params, signal);
          if (!signal.aborted) setCostData(resp);
        } else {
          const resp = await fetchRuntimeMonitoring(runtimeWindow, signal);
          if (!signal.aborted) setRuntimeData(resp);
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
    [dimension, range, granularity, runtimeWindow, selectedProject, selectedProvider, selectedModel, streamMode],
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
    (dimension === "usage" ? usageData?.meta : undefined) ??
    (dimension === "performance" ? perfData?.meta : undefined) ??
    (dimension === "routing" ? routingData?.meta : undefined) ??
    (dimension === "errors" ? errorsData?.meta : undefined) ??
    costData?.meta ??
    usageData?.meta ??
    perfData?.meta ??
    routingData?.meta ??
    errorsData?.meta;

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
                多维度细粒度指标监控面板
                {dimension === "runtime" && runtimeData
                  ? ` · 采样间隔: ${runtimeData.intervalSecs}s (${runtimeData.snapshot.os})`
                  : activeMeta
                    ? ` · 粒度: ${activeMeta.granularity} (${activeMeta.timezone})`
                    : ""}
                {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
              </p>
            </div>
          </div>

          <div className="header-controls">
            {dimension === "runtime" ? (
              <div className="segmented-group" role="group" aria-label="运行时采样窗口">
                {RUNTIME_WINDOWS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`segmented-btn${runtimeWindow === item.key ? " active" : ""}`}
                    onClick={() => { setRuntimeWindow(item.key); }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : (
              <>
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
              </>
            )}

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

        {dimension === "usage" ? (
          <UsageView data={usageData} loading={isRefreshing && !usageData} />
        ) : null}

        {dimension === "performance" ? (
          <PerformanceView
            data={perfData}
            loading={isRefreshing && !perfData}
            streamMode={streamMode}
            onStreamModeChange={setStreamMode}
          />
        ) : null}

        {dimension === "routing" ? (
          <RoutingView data={routingData} loading={isRefreshing && !routingData} />
        ) : null}

        {dimension === "errors" ? (
          <ErrorsView data={errorsData} loading={isRefreshing && !errorsData} />
        ) : null}

        {dimension === "cost" ? (
          <CostView data={costData} loading={isRefreshing && !costData} />
        ) : null}

        {dimension === "runtime" ? (
          <RuntimeView data={runtimeData} loading={isRefreshing && !runtimeData} />
        ) : null}
      </main>
    </div>
  );
}

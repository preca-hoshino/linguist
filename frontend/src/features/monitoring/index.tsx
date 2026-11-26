import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Pause, Play, RefreshCw } from "lucide-react";
import { usePreferences } from "@/context/preferences-provider";
import { ConfigDrawer } from "@/components/config-drawer";
import { Header } from "@/components/layout/header";
import { Main } from "@/components/layout/main";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { Search } from "@/components/search";
import { ThemeSwitch } from "@/components/theme-switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchCostMonitoring,
  fetchErrorsMonitoring,
  fetchPerformanceMonitoring,
  fetchRoutingMonitoring,
  fetchRuntimeMonitoring,
  fetchTrafficMonitoring,
} from "./api";
import { CostView } from "./components/views/cost-view";
import { ErrorsView } from "./components/views/errors-view";
import { PerformanceView } from "./components/views/performance-view";
import { RoutingView } from "./components/views/routing-view";
import { RuntimeView } from "./components/views/runtime-view";
import { UsageView } from "./components/views/usage-view";
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
} from "./types";

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

function parseDimension(raw: string | null): MonitoringDimension {
  if (
    raw === "usage" ||
    raw === "performance" ||
    raw === "routing" ||
    raw === "errors" ||
    raw === "cost" ||
    raw === "runtime"
  ) {
    return raw;
  }
  return "usage";
}

export function DataMonitoringPage() {
  const { preferences } = usePreferences();
  const [searchParams, setSearchParams] = useSearchParams();
  const dimension = parseDimension(searchParams.get("tab"));

  const [range, setRange] = useState<TimeRangeKey>(preferences.defaultMonitoringRange);
  const [granularity, setGranularity] = useState<GranularityKey>("auto");
  const [runtimeWindow, setRuntimeWindow] = useState<RuntimeWindowKey>("15m");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [streamMode, setStreamMode] = useState<StreamModeKey>("all");

  const [autoRefresh, setAutoRefresh] = useState(preferences.pollingIntervalMs > 0);
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
    [
      dimension,
      range,
      granularity,
      runtimeWindow,
      selectedProject,
      selectedProvider,
      selectedModel,
      streamMode,
    ],
  );

  useEffect(() => {
    void loadDimension();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadDimension]);

  const effectivePollMs =
    preferences.pollingIntervalMs > 0 ? preferences.pollingIntervalMs : 5000;

  useEffect(() => {
    setAutoRefresh(preferences.pollingIntervalMs > 0);
  }, [preferences.pollingIntervalMs]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadDimension(true);
    }, effectivePollMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, effectivePollMs, loadDimension]);

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
    <>
      <Header fixed>
        <Search className="me-auto" />
        <div className="flex items-center gap-2">
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main className="flex flex-1 flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">数据监控</h1>
            <p className="text-sm text-muted-foreground">
              多维度细粒度指标监控面板
              {dimension === "runtime" && runtimeData
                ? ` · 采样间隔: ${runtimeData.intervalSecs}s (${runtimeData.snapshot.os})`
                : activeMeta
                  ? ` · 粒度: ${activeMeta.granularity} (${activeMeta.timezone})`
                  : ""}
              {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={autoRefresh ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setAutoRefresh((v) => !v);
              }}
            >
              {autoRefresh ? (
                <>
                  <Pause className="size-3.5" />
                  {Math.round((preferences.pollingIntervalMs || 5000) / 1000)}s 刷新
                </>
              ) : (
                <>
                  <Play className="size-3.5" />
                  已暂停
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={isRefreshing}
              onClick={() => {
                void loadDimension();
              }}
            >
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
          </div>
        </div>

        {/* Global Filters Row */}
        <div className="flex flex-wrap items-center gap-2">
          {dimension === "runtime" ? (
            <Tabs
              value={runtimeWindow}
              onValueChange={(v) => {
                setRuntimeWindow(v as RuntimeWindowKey);
              }}
            >
              <TabsList className="h-8">
                {RUNTIME_WINDOWS.map((item) => (
                  <TabsTrigger key={item.key} value={item.key} className="text-xs">
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <>
              <Tabs
                value={range}
                onValueChange={(v) => {
                  setRange(v as TimeRangeKey);
                }}
              >
                <TabsList className="h-8">
                  {TIME_RANGES.map((item) => (
                    <TabsTrigger key={item.key} value={item.key} className="text-xs">
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <Select
                value={granularity}
                onValueChange={(v) => {
                  setGranularity(v as GranularityKey);
                }}
              >
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANULARITIES.map((g) => (
                    <SelectItem key={g.key} value={g.key}>
                      粒度: {g.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedProject || "__all__"}
                onValueChange={(v) => {
                  setSelectedProject(v === "__all__" ? "" : v);
                }}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue placeholder="全部项目" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部项目</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedProvider || "__all__"}
                onValueChange={(v) => {
                  setSelectedProvider(v === "__all__" ? "" : v);
                }}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue placeholder="全部供应商" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部供应商</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedModel || "__all__"}
                onValueChange={(v) => {
                  setSelectedModel(v === "__all__" ? "" : v);
                }}
              >
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="全部模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部模型</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>

        <Tabs
          value={dimension}
          onValueChange={(v) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", v);
            setSearchParams(next, { replace: true });
          }}
          className="space-y-4"
        >
          <div className="w-full overflow-x-auto pb-1">
            <TabsList>
              {DIMENSIONS.map((d) => (
                <TabsTrigger key={d.key} value={d.key}>
                  {d.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {errorMsg ? (
            <Alert variant="destructive">
              <AlertTitle>监控数据加载失败</AlertTitle>
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          ) : null}

          <TabsContent value="usage" className="mt-0">
            <UsageView data={usageData} loading={isRefreshing && !usageData} />
          </TabsContent>
          <TabsContent value="performance" className="mt-0">
            <PerformanceView
              data={perfData}
              loading={isRefreshing && !perfData}
              streamMode={streamMode}
              onStreamModeChange={setStreamMode}
            />
          </TabsContent>
          <TabsContent value="routing" className="mt-0">
            <RoutingView data={routingData} loading={isRefreshing && !routingData} />
          </TabsContent>
          <TabsContent value="errors" className="mt-0">
            <ErrorsView data={errorsData} loading={isRefreshing && !errorsData} />
          </TabsContent>
          <TabsContent value="cost" className="mt-0">
            <CostView data={costData} loading={isRefreshing && !costData} />
          </TabsContent>
          <TabsContent value="runtime" className="mt-0">
            <RuntimeView data={runtimeData} loading={isRefreshing && !runtimeData} />
          </TabsContent>
        </Tabs>
      </Main>
    </>
  );
}

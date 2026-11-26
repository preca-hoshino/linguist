import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { usePreferences } from "@/context/preferences-provider";
import { getBillingDashboard, billingError, type BillingDashboard } from "@/features/logs/api";
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
import { fetchDailyModels, fetchLeaderboard, fetchOverview } from "./api";
import { ContributionWall } from "./components/contribution-wall";
import { ModelLeaderboard } from "./components/model-leaderboard";
import { TokenStackedChart } from "./components/token-stacked-chart";
import type {
  DailyModelDay,
  LeaderboardItem,
  LeaderboardSort,
  OverviewResponse,
} from "./types";

export function DashboardPage() {
  const { preferences } = usePreferences();
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");

  const [leaderboardDays, setLeaderboardDays] = useState(30);
  const [leaderboardSort, setLeaderboardSort] = useState<LeaderboardSort>("avg_decode_tps");
  const [dailyDays, setDailyDays] = useState(30);

  const [autoRefresh, setAutoRefresh] = useState(preferences.pollingIntervalMs > 0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardItem[]>([]);
  const [dailyModels, setDailyModels] = useState<DailyModelDay[]>([]);
  const [billingResult, setBillingResult] = useState<{
    key: string;
    data: BillingDashboard | null;
    error: string;
  } | null>(null);
  const [billingRefresh, setBillingRefresh] = useState(0);
  const billingKey = JSON.stringify([selectedProject, selectedProvider]);
  const billing = billingResult?.key === billingKey ? billingResult.data : null;
  const billingErrorMessage = billingResult?.key === billingKey ? billingResult.error : "";

  const pending = useRef<AbortController | null>(null);
  const loadAll = useCallback(
    async (skipIfPending = false) => {
      if (skipIfPending && pending.current) return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const { signal } = controller;
      setIsRefreshing(true);
      try {
        const [ov, lb, dm] = await Promise.all([
          fetchOverview(selectedProject, selectedProvider, 365, signal),
          fetchLeaderboard(
            selectedProject,
            selectedProvider,
            leaderboardDays > 0 ? leaderboardDays : undefined,
            leaderboardSort,
            signal,
          ),
          fetchDailyModels(selectedProject, selectedProvider, dailyDays, signal),
        ]);
        if (signal.aborted) return;
        setOverview(ov);
        setLeaderboard(lb);
        setDailyModels(dm);
        setBillingRefresh((current) => current + 1);
        setErrorMsg(null);
        setLastUpdated(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch (err) {
        if (!signal.aborted) {
          setErrorMsg(err instanceof Error ? err.message : "Failed to load telemetry");
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          if (!signal.aborted) setIsRefreshing(false);
          controller.abort();
        }
      }
    },
    [selectedProject, selectedProvider, leaderboardDays, leaderboardSort, dailyDays],
  );

  useEffect(() => {
    void loadAll();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadAll]);

  const effectivePollMs =
    preferences.pollingIntervalMs > 0 ? preferences.pollingIntervalMs : 5000;

  useEffect(() => {
    setAutoRefresh(preferences.pollingIntervalMs > 0);
  }, [preferences.pollingIntervalMs]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadAll(true);
    }, effectivePollMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, effectivePollMs, loadAll]);

  useEffect(() => {
    const controller = new AbortController();
    void getBillingDashboard(selectedProject, selectedProvider, [], controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setBillingResult({ key: billingKey, data, error: "" });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setBillingResult({ key: billingKey, data: null, error: billingError(error) });
        }
      });
    return () => {
      controller.abort();
    };
  }, [billingKey, billingRefresh, selectedProject, selectedProvider]);

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
            <h1 className="text-2xl font-bold tracking-tight">
              {overview?.title ?? "统计总览"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Programmable OpenAI Chat Gateway &amp; Token Telemetry
              {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedProject || "__all__"}
              onValueChange={(v) => {
                setSelectedProject(v === "__all__" ? "" : v);
              }}
            >
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder="全部项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部项目</SelectItem>
                {(overview?.projects ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    项目: {p.name}
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
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder="全部提供商" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部提供商</SelectItem>
                {(overview?.providers ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    提供商: {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant={autoRefresh ? "secondary" : "outline"}
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setAutoRefresh((prev) => !prev);
              }}
            >
              {autoRefresh ? (
                <>
                  <Pause className="size-3.5" />
                  轮询 {Math.round((preferences.pollingIntervalMs || 5000) / 1000)}s
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
                void loadAll();
              }}
            >
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              立即刷新
            </Button>
          </div>
        </div>

        {errorMsg ? (
          <Alert variant="destructive">
            <AlertTitle>数据加载失败</AlertTitle>
            <AlertDescription>{errorMsg}</AlertDescription>
          </Alert>
        ) : null}

        <ContributionWall
          summary={
            overview?.summary ?? {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheHitRate: 0,
              totalRequests: 0,
              activeStreakDays: 0,
              topModel: null,
            }
          }
          days={overview?.days ?? []}
          billing={billing}
          billingError={billingErrorMessage}
          billingLoading={!billing && !billingErrorMessage}
        />

        <ModelLeaderboard
          items={leaderboard}
          days={leaderboardDays}
          sort={leaderboardSort}
          onDaysChange={setLeaderboardDays}
          onSortChange={setLeaderboardSort}
        />

        <TokenStackedChart
          daysData={dailyModels}
          daysWindow={dailyDays}
          onDaysWindowChange={setDailyDays}
        />
      </Main>
    </>
  );
}

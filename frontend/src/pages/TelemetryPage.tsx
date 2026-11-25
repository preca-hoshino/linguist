import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDailyModels,
  fetchLeaderboard,
  fetchOverview,
} from "../api/client";
import { ContributionWall } from "../components/ContributionWall";
import { HeaderBar } from "../components/HeaderBar";
import { ModelLeaderboard } from "../components/ModelLeaderboard";
import { TokenStackedChart } from "../components/TokenStackedChart";
import type {
  DailyModelDay,
  LeaderboardItem,
  LeaderboardSort,
  OverviewResponse,
} from "../types/telemetry";
import { billingError, getBillingDashboard } from "../billing/api";
import type { BillingDashboard } from "../billing/api";

export function TelemetryPage() {
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");

  const [leaderboardDays, setLeaderboardDays] = useState(30);
  const [leaderboardSort, setLeaderboardSort] = useState<LeaderboardSort>("avg_decode_tps");
  const [dailyDays, setDailyDays] = useState(30);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardItem[]>([]);
  const [dailyModels, setDailyModels] = useState<DailyModelDay[]>([]);
  const [billingResult, setBillingResult] = useState<{ key: string; data: BillingDashboard | null; error: string } | null>(null);
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
    [
      selectedProject,
      selectedProvider,
      leaderboardDays,
      leaderboardSort,
      dailyDays,
    ],
  );

  useEffect(() => {
    void loadAll();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadAll]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadAll(true);
    }, 5000);
    return () => { window.clearInterval(timer); };
  }, [autoRefresh, loadAll]);

  useEffect(() => {
    const controller = new AbortController();
    void getBillingDashboard(selectedProject, selectedProvider, [], controller.signal)
      .then((data) => { if (!controller.signal.aborted) setBillingResult({ key: billingKey, data, error: "" }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setBillingResult({ key: billingKey, data: null, error: billingError(error) }); });
    return () => { controller.abort(); };
  }, [billingKey, billingRefresh, selectedProject, selectedProvider]);

  return (
    <div className="app-shell">
      <HeaderBar
        title={overview?.title ?? "Linguist Gateway & Telemetry"}
        projects={overview?.projects ?? []}
        providers={overview?.providers ?? []}
        selectedProject={selectedProject}
        selectedProvider={selectedProvider}
        autoRefresh={autoRefresh}
        isRefreshing={isRefreshing}
        lastUpdated={lastUpdated}
        onProjectChange={setSelectedProject}
        onProviderChange={setSelectedProvider}
        onToggleAutoRefresh={() => {
          setAutoRefresh((prev) => !prev);
        }}
        onManualRefresh={() => {
          void loadAll();
        }}
      />

      <main className="page-container" id="main-content" tabIndex={-1}>
        {errorMsg ? <div className="error-banner">数据加载失败：{errorMsg}</div> : null}

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
      </main>
    </div>
  );
}

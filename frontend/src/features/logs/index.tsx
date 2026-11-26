import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { usePreferences } from "@/context/preferences-provider";
import { fetchRecentRequests } from "@/features/dashboard/api";
import type { RecentRequestsResponse } from "@/features/dashboard/types";
import { ConfigDrawer } from "@/components/config-drawer";
import { Header } from "@/components/layout/header";
import { Main } from "@/components/layout/main";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { Search } from "@/components/search";
import { ThemeSwitch } from "@/components/theme-switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RequestBillingSheet } from "./components/request-billing-sheet";
import { RequestsTable } from "./components/requests-table";

export function RequestLogsPage() {
  const { preferences } = usePreferences();
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(preferences.defaultLogsPageSize);

  const [autoRefresh, setAutoRefresh] = useState(preferences.pollingIntervalMs > 0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [data, setData] = useState<RecentRequestsResponse | null>(null);
  const [selectedRequestUid, setSelectedRequestUid] = useState<string | null>(null);

  const pending = useRef<AbortController | null>(null);

  const loadLogs = useCallback(
    async (skipIfPending = false) => {
      if (skipIfPending && pending.current) return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const { signal } = controller;
      setIsRefreshing(true);
      try {
        const resp = await fetchRecentRequests(
          {
            projectId: selectedProject,
            providerId: selectedProvider,
            modelId: selectedModel,
            status: selectedStatus,
            page,
            pageSize,
          },
          signal,
        );
        if (signal.aborted) return;
        setData(resp);
        if (resp.totalPages > 0 && page > resp.totalPages) {
          setPage(resp.totalPages);
        }
        setErrorMsg(null);
        setLastUpdated(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      } catch (err) {
        if (!signal.aborted) {
          setErrorMsg(err instanceof Error ? err.message : "请求日志加载失败");
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          if (!signal.aborted) setIsRefreshing(false);
        }
      }
    },
    [selectedProject, selectedProvider, selectedModel, selectedStatus, page, pageSize],
  );

  useEffect(() => {
    void loadLogs();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [loadLogs]);

  const effectivePollMs =
    preferences.pollingIntervalMs > 0 ? preferences.pollingIntervalMs : 5000;

  useEffect(() => {
    setAutoRefresh(preferences.pollingIntervalMs > 0);
  }, [preferences.pollingIntervalMs]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadLogs(true);
    }, effectivePollMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, effectivePollMs, loadLogs]);

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

      <Main className="flex flex-1 flex-col gap-4 sm:gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">请求日志</h1>
            <p className="text-sm text-muted-foreground">
              实时透传请求流水、Token 分布、费用明细与速率指标
              {lastUpdated ? ` · 更新于 ${lastUpdated}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
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
                  自动轮询 {Math.round((preferences.pollingIntervalMs || 5000) / 1000)}s
                </>
              ) : (
                <>
                  <Play className="size-3.5" />
                  已暂停轮询
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
                void loadLogs();
              }}
            >
              <RefreshCw className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
          </div>
        </div>

        {errorMsg ? (
          <Alert variant="destructive">
            <AlertTitle>日志加载失败</AlertTitle>
            <AlertDescription>{errorMsg}</AlertDescription>
          </Alert>
        ) : null}

        {!data && isRefreshing ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        ) : (
          <RequestsTable
            items={data?.items ?? []}
            projects={data?.projects ?? []}
            providers={data?.providers ?? []}
            models={data?.models ?? []}
            selectedProject={selectedProject}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            selectedStatus={selectedStatus}
            page={data?.page ?? page}
            pageSize={data?.pageSize ?? pageSize}
            total={data?.total ?? 0}
            totalPages={data?.totalPages ?? 1}
            displayCurrency={data?.displayCurrency ?? null}
            onProjectChange={(val) => {
              setSelectedProject(val);
              setPage(1);
            }}
            onProviderChange={(val) => {
              setSelectedProvider(val);
              setPage(1);
            }}
            onModelChange={(val) => {
              setSelectedModel(val);
              setPage(1);
            }}
            onStatusChange={(val) => {
              setSelectedStatus(val);
              setPage(1);
            }}
            onResetFilters={() => {
              setSelectedProject("");
              setSelectedProvider("");
              setSelectedModel("");
              setSelectedStatus("");
              setPage(1);
            }}
            onPageChange={setPage}
            onPageSizeChange={(nextSize) => {
              setPageSize(nextSize);
              setPage(1);
            }}
            onSelectBilling={(uid) => {
              setSelectedRequestUid(uid);
            }}
          />
        )}
      </Main>

      <RequestBillingSheet
        requestUid={selectedRequestUid}
        onClose={() => {
          setSelectedRequestUid(null);
        }}
      />
    </>
  );
}

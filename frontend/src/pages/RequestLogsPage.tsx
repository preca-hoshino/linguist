import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRecentRequests } from "../api/client";
import { HeaderBar } from "../components/HeaderBar";
import { RecentRequestsTable } from "../components/RecentRequestsTable";
import type { RecentRequestsResponse } from "../types/telemetry";

export function RequestLogsPage() {
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [data, setData] = useState<RecentRequestsResponse | null>(null);

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
          setErrorMsg(err instanceof Error ? err.message : "Failed to load request logs");
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

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadLogs(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, loadLogs]);

  return (
    <div className="app-shell">
      <HeaderBar
        title="请求日志"
        projects={data?.projects ?? []}
        providers={data?.providers ?? []}
        selectedProject={selectedProject}
        selectedProvider={selectedProvider}
        autoRefresh={autoRefresh}
        isRefreshing={isRefreshing}
        lastUpdated={lastUpdated}
        onProjectChange={(val) => {
          setSelectedProject(val);
          setPage(1);
        }}
        onProviderChange={(val) => {
          setSelectedProvider(val);
          setPage(1);
        }}
        onToggleAutoRefresh={() => {
          setAutoRefresh((prev) => !prev);
        }}
        onManualRefresh={() => {
          void loadLogs();
        }}
      />

      <main className="page-container" id="main-content" tabIndex={-1}>
        {errorMsg ? <div className="error-banner">日志加载失败：{errorMsg}</div> : null}

        <RecentRequestsTable
          items={data?.items ?? []}
          models={data?.models ?? []}
          selectedModel={selectedModel}
          selectedStatus={selectedStatus}
          page={data?.page ?? page}
          pageSize={data?.pageSize ?? pageSize}
          total={data?.total ?? 0}
          totalPages={data?.totalPages ?? 1}
          hasNext={data?.hasNext ?? false}
          displayCurrency={data?.displayCurrency ?? null}
          onModelChange={(val) => {
            setSelectedModel(val);
            setPage(1);
          }}
          onStatusChange={(val) => {
            setSelectedStatus(val);
            setPage(1);
          }}
          onPageChange={setPage}
          onPageSizeChange={(nextSize) => {
            setPageSize(nextSize);
            setPage(1);
          }}
        />
      </main>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { getCatalogStatus } from "@/features/catalog/api";
import type { CatalogStatus } from "@/features/catalog/types";
import {
  fetchRuntimeMonitoring,
  formatBytes,
  formatUptime,
} from "@/features/monitoring/api";
import type { RuntimeMonitoringResponse } from "@/features/monitoring/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ContentSection } from "../components/content-section";

export function SystemSettings() {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeMonitoringResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled([
      getCatalogStatus(controller.signal),
      fetchRuntimeMonitoring("15m", controller.signal),
    ]).then(([catRes, rtRes]) => {
      if (controller.signal.aborted) return;
      if (catRes.status === "fulfilled") setStatus(catRes.value);
      if (rtRes.status === "fulfilled") setRuntime(rtRes.value);
      setLoading(false);
    });
    return () => {
      controller.abort();
    };
  }, [nonce]);

  const snap = runtime?.snapshot;
  const revSynced = status ? status.revision === status.loadedRevision : true;

  return (
    <ContentSection
      title="系统状态"
      desc="查看 PostgreSQL 配置目录同步版本、Rust 网关运行时健康指标与第三方开源许可声明。"
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">实时拉取服务端只读状态</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              setNonce((n) => n + 1);
            }}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            刷新状态
          </Button>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">配置目录同步 (PostgreSQL)</CardTitle>
              <CardDescription>热加载 ArcSwap 快照与数据库版本号一致性</CardDescription>
            </div>
            {status ? (
              <Badge variant={revSynced ? "secondary" : "destructive"}>
                {revSynced ? "已同步" : "存在待同步变更"}
              </Badge>
            ) : null}
          </CardHeader>
          <CardContent>
            {loading && !status ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">数据库版本</dt>
                  <dd className="mono mt-1 font-semibold">r{status?.revision ?? "—"}</dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">网关加载版本</dt>
                  <dd className="mono mt-1 font-semibold">r{status?.loadedRevision ?? "—"}</dd>
                </div>
                <div className="rounded-lg border p-3 col-span-2 sm:col-span-1">
                  <dt className="text-xs text-muted-foreground">写入模式</dt>
                  <dd className="mono mt-1 font-semibold">{status?.writeMode ?? "postgres"}</dd>
                </div>
              </dl>
            )}
            {status?.syncError ? (
              <p className="mt-3 text-xs text-destructive">同步异常: {status.syncError}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">网关运行时摘要</CardTitle>
            <CardDescription>进程资源占用、PostgreSQL 连接池与 Redis 缓存连接状态</CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !snap ? (
              <Skeleton className="h-28 w-full" />
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">运行时长</dt>
                  <dd className="mono mt-1 font-semibold">
                    {snap ? formatUptime(snap.uptimeSecs) : "—"}
                  </dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">物理内存 (RSS)</dt>
                  <dd className="mono mt-1 font-semibold">
                    {snap ? formatBytes(snap.rssBytes) : "—"}
                  </dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">PG 连接池</dt>
                  <dd className="mono mt-1 font-semibold">
                    {snap ? `${snap.pgPoolSize - snap.pgPoolIdle} / ${snap.pgPoolSize}` : "—"}
                  </dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">活跃 SSE 流</dt>
                  <dd className="mono mt-1 font-semibold">{snap?.activeSseStreams ?? "—"}</dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">Redis 缓存</dt>
                  <dd className="mt-1 font-semibold">
                    {snap ? (snap.redisEnabled ? (snap.redisConnected ? "已连接" : "断开") : "未启用") : "—"}
                  </dd>
                </div>
                <div className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">系统平台</dt>
                  <dd className="mono mt-1 text-xs">{snap?.os ?? "—"}</dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">开源合规与许可声明</CardTitle>
            <CardDescription>查看嵌入式前端与图标库的所有第三方许可证全文</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <a href="/third-party-notices.txt" target="_blank" rel="noreferrer" className="gap-2">
                查看 third-party-notices.txt
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </ContentSection>
  );
}

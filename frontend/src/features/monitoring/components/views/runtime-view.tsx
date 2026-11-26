import { formatBps, formatBytes, formatCompactNumber, formatMs, formatUptime } from "../../api";
import type { HttpChannelRow, RuntimeMonitoringResponse } from "../../types";
import { ChartCard } from "../chart-card";
import { HorizontalBarChart } from "../charts/horizontal-bar-chart";
import { LineAreaChart } from "../charts/line-area-chart";
import { StackedBarChart } from "../charts/stacked-bar-chart";
import { MiniTableCard, type MiniTableColumn } from "../mini-table-card";
import { SectionGroup } from "../section-group";
import { StatKpiCard } from "../stat-kpi-card";

interface RuntimeViewProps {
  data: RuntimeMonitoringResponse | null;
  loading: boolean;
}

const CHANNEL_COLUMNS: MiniTableColumn<HttpChannelRow>[] = [
  {
    key: "direction",
    label: "方向",
    render: (r) => (
      <span className="mono">{r.direction === "inbound" ? "入站 ↓" : "出站 ↑"}</span>
    ),
  },
  {
    key: "label",
    label: "通道 / 端点组",
    render: (r) => r.label,
  },
  {
    key: "total",
    label: "累计请求",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.totalRequests)}</span>,
  },
  {
    key: "inflight",
    label: "在途并发",
    align: "right",
    render: (r) => <span className="mono">{r.inflight}</span>,
  },
  {
    key: "s2xx",
    label: "2xx",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.s2xx)}</span>,
  },
  {
    key: "s4xx",
    label: "4xx / 拦截",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.s4xx)}</span>,
  },
  {
    key: "s5xx",
    label: "5xx / 失败",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.s5xxOrErr)}</span>,
  },
  {
    key: "avgMs",
    label: "平均耗时",
    align: "right",
    render: (r) => (
      <span className="mono">{r.avgDurationMs > 0 ? formatMs(r.avgDurationMs) : "—"}</span>
    ),
  },
  {
    key: "rx",
    label: "接收 (RX)",
    align: "right",
    render: (r) => <span className="mono">{formatBytes(r.rxBytes)}</span>,
  },
  {
    key: "tx",
    label: "发出 (TX)",
    align: "right",
    render: (r) => <span className="mono">{formatBytes(r.txBytes)}</span>,
  },
];

export function RuntimeView({ data, loading }: RuntimeViewProps) {
  const snap = data?.snapshot;
  const samples = data?.samples ?? [];
  const channels = data?.channels ?? [];
  const hasSamples = samples.length > 0;

  const rssSub = snap?.cgroupLimitBytes
    ? `容器限额 ${formatBytes(snap.cgroupLimitBytes)} (${(((snap.cgroupMemoryBytes ?? snap.rssBytes) * 100) / snap.cgroupLimitBytes).toFixed(1)}%)`
    : `峰值 ${formatBytes(snap?.peakRssBytes ?? 0)} · 系统总内存 ${formatBytes(snap?.systemTotalBytes ?? 0)}`;

  const pgActive = snap ? Math.max(0, snap.pgPoolSize - snap.pgPoolIdle) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatKpiCard
          title="进程内存 (VmRSS)"
          value={formatBytes(snap?.rssBytes ?? 0)}
          subValue={rssSub}
          helpText="当前网关进程物理内存占用，以及容器 cgroup 或峰值 RSS"
          tone="blue"
        />
        <StatKpiCard
          title="运行时长 & 资源"
          value={formatUptime(snap?.uptimeSecs ?? 0)}
          subValue={`CPU ${(snap?.cpuPercent ?? 0).toFixed(1)}% · Rev ${snap?.catalogRevision ?? 0}${snap?.openFds !== null && snap?.openFds !== undefined ? ` · FD ${snap.openFds}` : ""}`}
          helpText="进程启动时长、CPU 占用、配置版本与打开文件描述符数量"
        />
        <StatKpiCard
          title="在途并发 & 活跃 SSE 流"
          value={`${snap?.inboundInflight ?? 0} / ${snap?.activeSseStreams ?? 0}`}
          subValue={`出站在途 ${snap?.outboundInflight ?? 0}`}
          helpText="当前正在处理的入站 HTTP 请求数 / 活跃 SSE 长流连接数"
          tone={(snap?.activeSseStreams ?? 0) > 0 ? "green" : "default"}
        />
        <StatKpiCard
          title="入站 HTTP 实时速率"
          value={`${(snap?.currentInboundRps ?? 0).toFixed(2)} req/s`}
          subValue={`RX ${formatBps(snap?.currentInboundRxBps ?? 0)} · TX ${formatBps(snap?.currentInboundTxBps ?? 0)}`}
          helpText="全站接收客户端请求速率与入站收/发字节吞吐"
        />
        <StatKpiCard
          title="出站 HTTP 实时速率"
          value={`${(snap?.currentOutboundRps ?? 0).toFixed(2)} req/s`}
          subValue={`TX ${formatBps(snap?.currentOutboundTxBps ?? 0)} · RX ${formatBps(snap?.currentOutboundRxBps ?? 0)}`}
          helpText="网关向上游模型与脚本联网发出的 HTTP 速率与吞吐"
        />
        <StatKpiCard
          title="PG 连接池 & 日志队列"
          value={`${pgActive} / ${snap?.pgPoolSize ?? 0}`}
          subValue={`日志队列 ${snap?.logQueueDepth ?? 0}/${snap?.logQueueCapacity ?? 1024} · 丢弃 ${snap?.logDropped ?? 0}`}
          helpText="PostgreSQL 活跃/总连接数，以及异步写库通道排队深度"
          tone={(snap?.logDropped ?? 0) > 0 ? "red" : "green"}
        />
      </div>

      <ChartCard
        fullWidth
        title="全站 HTTP 收发核心汇总"
        helpText="覆盖网关接收的所有入站路由与发出的出站上游/脚本联网通道"
        loading={loading}
        empty={channels.length === 0}
        expandable={false}
      >
        <MiniTableCard
          columns={CHANNEL_COLUMNS}
          rows={channels}
          rowKey={(r) => `${r.direction}-${r.key}`}
        />
      </ChartCard>

      <SectionGroup title="内存、CPU 与系统资源" subtitle="网关进程物理内存走势、CPU 占用与连接池">
        <ChartCard
          title="进程内存占用趋势 (MB)"
          helpText="RSS 物理内存、历史峰值与容器 cgroup 内存趋势"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                rss: s.rssMb,
                peak: s.peakRssMb,
                ...(s.cgroupMb !== null ? { cgroup: s.cgroupMb } : {}),
              },
            }))}
            series={[
              { key: "rss", label: "VmRSS (MB)", color: "#4B7FFF", area: true },
              { key: "peak", label: "Peak RSS (MB)", color: "#F59E0B", dashed: true },
              ...(samples.some((s) => s.cgroupMb !== null)
                ? [{ key: "cgroup", label: "Cgroup (MB)", color: "#14B8A6" }]
                : []),
            ]}
            formatValue={(v) => `${v.toFixed(1)} MB`}
          />
        </ChartCard>

        <ChartCard title="进程 CPU 使用率 (%)" loading={loading} empty={!hasSamples}>
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: { cpu: s.cpuPercent },
            }))}
            series={[{ key: "cpu", label: "CPU %", color: "#6366F1", area: true }]}
            formatValue={(v) => `${v.toFixed(1)}%`}
          />
        </ChartCard>

        <ChartCard
          title="在途并发与活跃 SSE 长连接"
          helpText="入站在途、活跃 SSE 响应流与出站在途并发"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                inFlight: s.inboundInflight,
                sse: s.activeSseStreams,
                outFlight: s.outboundInflight,
              },
            }))}
            series={[
              { key: "inFlight", label: "入站在途", color: "#4B7FFF", area: true },
              { key: "sse", label: "活跃 SSE 流", color: "#22C55E" },
              { key: "outFlight", label: "出站在途", color: "#F59E0B" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="入站 HTTP（接收请求与发出响应）" subtitle="全量入站请求速率、吞吐与状态码分布">
        <ChartCard
          title="入站请求速率 (RPS)"
          helpText="按 AI 代理、管理/鉴权 API 与健康检查/静态资源分类"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                proxy: s.inboundProxyRps,
                api: s.inboundApiRps,
                other: s.inboundOtherRps,
              },
            }))}
            series={[
              { key: "proxy", label: "AI 代理", color: "#4B7FFF", area: true },
              { key: "api", label: "控制台与鉴权", color: "#14B8A6" },
              { key: "other", label: "健康检查/静态", color: "#94A3B8" },
            ]}
            formatValue={(v) => `${v.toFixed(2)}/s`}
          />
        </ChartCard>

        <ChartCard
          title="入站网络收发吞吐 (Bytes/s)"
          helpText="接收请求体速率 (RX) vs 发出客户端响应速率 (TX)"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: { rx: s.inboundRxBps, tx: s.inboundTxBps },
            }))}
            series={[
              { key: "tx", label: "发出响应 (TX)", color: "#4B7FFF", area: true },
              { key: "rx", label: "接收请求 (RX)", color: "#14B8A6" },
            ]}
            formatValue={formatBps}
          />
        </ChartCard>

        <ChartCard title="入站 HTTP 响应状态码" loading={loading} empty={!hasSamples}>
          <StackedBarChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                s2xx: s.inbound2xx,
                s3xx: s.inbound3xx,
                s4xx: s.inbound4xx,
                s5xx: s.inbound5xx,
              },
            }))}
            series={[
              { key: "s2xx", label: "2xx", color: "#22C55E" },
              { key: "s3xx", label: "3xx", color: "#0EA5E9" },
              { key: "s4xx", label: "4xx", color: "#F59E0B" },
              { key: "s5xx", label: "5xx", color: "#EF4444" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="出站 HTTP（向上游发请求与收响应）" subtitle="代理向上游厂商发出的 HTTP 吞吐与健康度">
        <ChartCard title="出站请求速率 (RPS)" loading={loading} empty={!hasSamples}>
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: { rps: s.outboundRps },
            }))}
            series={[{ key: "rps", label: "出站 RPS", color: "#6366F1", area: true }]}
            formatValue={(v) => `${v.toFixed(2)}/s`}
          />
        </ChartCard>

        <ChartCard
          title="出站网络收发吞吐 (Bytes/s)"
          helpText="发往上游请求体 (TX) vs 接收上游响应体 (RX)"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: { tx: s.outboundTxBps, rx: s.outboundRxBps },
            }))}
            series={[
              { key: "rx", label: "收上游响应 (RX)", color: "#22C55E", area: true },
              { key: "tx", label: "发上游请求 (TX)", color: "#F59E0B" },
            ]}
            formatValue={formatBps}
          />
        </ChartCard>

        <ChartCard
          title="出站响应健康度"
          helpText="上游 2xx、429 限流、4xx/5xx、建连超时与 SSE 中断"
          loading={loading}
          empty={!hasSamples}
        >
          <StackedBarChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                s2xx: s.outbound2xx,
                s429: s.outbound429,
                err: s.outboundErr,
                conn: s.outboundConnErr,
                sseInt: s.outboundSseInterrupted,
              },
            }))}
            series={[
              { key: "s2xx", label: "2xx", color: "#22C55E" },
              { key: "s429", label: "429", color: "#F59E0B" },
              { key: "err", label: "4xx/5xx", color: "#EF4444" },
              { key: "conn", label: "建连失败", color: "#EC4899" },
              { key: "sseInt", label: "SSE中断", color: "#6366F1" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="网关内部耗时、连接池与脚本引擎" subtitle="微秒级阶段延迟、异步日志队列与 Boa 沙箱统计">
        <ChartCard
          title="网关内部处理耗时 (ms)"
          helpText="采样周期内平均路由①~③耗时与适配④~⑤耗时"
          loading={loading}
          empty={!hasSamples}
        >
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: { routing: s.avgRoutingMs, prep: s.avgPrepMs },
            }))}
            series={[
              { key: "routing", label: "路由①~③", color: "#6366F1", area: true },
              { key: "prep", label: "适配④~⑤", color: "#0EA5E9" },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>

        <ChartCard title="PG 连接池 & 异步日志队列" loading={loading} empty={!hasSamples}>
          <LineAreaChart
            data={samples.map((s) => ({
              label: s.label,
              values: {
                pgActive: s.pgActive,
                pgIdle: s.pgIdle,
                queue: s.logQueueDepth,
              },
            }))}
            series={[
              { key: "pgActive", label: "PG 活跃连接", color: "#4B7FFF" },
              { key: "pgIdle", label: "PG 空闲连接", color: "#14B8A6" },
              { key: "queue", label: "写库队列深度", color: "#F59E0B" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="脚本引擎 & 内存缓存统计" loading={loading} empty={!snap}>
          <HorizontalBarChart
            items={[
              {
                key: "onReq",
                label: "onRequest 执行数",
                value: snap?.scriptOnRequestCalls ?? 0,
                subLabel: `失败 ${snap?.scriptOnRequestErrors ?? 0}`,
                color: "#4B7FFF",
              },
              {
                key: "onBill",
                label: "onBilling 执行数",
                value: snap?.scriptOnBillingCalls ?? 0,
                subLabel: `失败 ${snap?.scriptOnBillingErrors ?? 0}`,
                color: "#14B8A6",
              },
              {
                key: "http",
                label: "linguist.http 联网",
                value: snap?.scriptHttpCalls ?? 0,
                subLabel: `缓存命中 ${snap?.scriptHttpCacheHits ?? 0} · 合并 ${snap?.scriptHttpSingleflight ?? 0}`,
                color: "#6366F1",
              },
              {
                key: "cache",
                label: "MetricsCache 样本数",
                value: snap?.metricsCacheSamples ?? 0,
                subLabel: `${snap?.metricsCacheEndpoints ?? 0} 个端点 · HTTP缓存 ${snap?.scriptHttpCacheEntries ?? 0} 条`,
                color: "#F59E0B",
              },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>
    </div>
  );
}

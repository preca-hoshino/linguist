import { useState } from "react";
import { modelColor } from "@/features/dashboard/api";
import { formatCompactNumber, formatMs } from "../../api";
import type { PerformanceMonitoringResponse, StreamModeKey } from "../../types";
import { ChartCard } from "../chart-card";
import { HorizontalBarChart } from "../charts/horizontal-bar-chart";
import { LineAreaChart } from "../charts/line-area-chart";
import { ScatterChart } from "../charts/scatter-chart";
import { StackedBarChart } from "../charts/stacked-bar-chart";
import { SectionGroup } from "../section-group";
import { StatKpiCard } from "../stat-kpi-card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface PerformanceViewProps {
  data: PerformanceMonitoringResponse | null;
  loading: boolean;
  streamMode: StreamModeKey;
  onStreamModeChange: (mode: StreamModeKey) => void;
}

export function PerformanceView({
  data,
  loading,
  streamMode,
  onStreamModeChange,
}: PerformanceViewProps) {
  const [heroScope, setHeroScope] = useState<"all" | "pre_first" | "gateway">("all");
  const buckets = data?.buckets ?? [];
  const summary = data?.summary;
  const quadrant = data?.modelQuadrant ?? [];
  const histogram = data?.ttftHistogram ?? [];
  const providerBench = data?.providerBenchmarks ?? [];
  const streamCmp = data?.streamComparison ?? [];
  const hasPerf = buckets.some((b) => b.ttftP50 > 0 || b.decodeTpsAvg > 0 || b.durationP50 > 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatKpiCard
          title="网关平均处理耗时"
          value={formatMs(summary?.avgGatewayOverheadMs ?? 0)}
          helpText="入站鉴权 + 阶段①~⑤脚本执行 + 出站序列化耗时"
          tone="blue"
        />
        <StatKpiCard
          title="首Token延时 (P50 / P90)"
          value={formatMs(summary?.ttftP50 ?? 0)}
          subValue={`P90 ${formatMs(summary?.ttftP90 ?? 0)}`}
          helpText="TTFT (Time To First Token) 中位数与 90 分位"
        />
        <StatKpiCard
          title="非首Token延时 (P50 TPOT)"
          value={formatMs(summary?.tpotP50 ?? 0)}
          subValue="ms / token (流式生成)"
          helpText="平均每个输出 Token 的解码间隔耗时 = generation_duration_ms / output_tokens"
          tone="green"
        />
        <StatKpiCard
          title="生成速率 (Decode TPS)"
          value={`${(summary?.decodeTpsAvg ?? 0).toFixed(1)} t/s`}
          subValue={`P50 ${(summary?.decodeTpsP50 ?? 0).toFixed(1)} t/s`}
          helpText="净解码生成吞吐速率"
        />
        <StatKpiCard
          title="接口延时 (P50 / P90)"
          value={formatMs(summary?.durationP50 ?? 0)}
          subValue={`P90 ${formatMs(summary?.durationP90 ?? 0)}`}
          helpText="完整请求端到端总耗时"
        />
      </div>

      <ChartCard
        fullWidth
        title="全链路延时分段拆解"
        helpText="从网关内部处理 → 上游建连响应头 → 首字等待 → 持续生成 4 段式耗时拆解"
        loading={loading}
        empty={!hasPerf}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={streamMode}
              onValueChange={(v) => {
                onStreamModeChange(v as StreamModeKey);
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">
                  全部
                </TabsTrigger>
                <TabsTrigger value="stream" className="text-xs">
                  仅流式
                </TabsTrigger>
                <TabsTrigger value="non_stream" className="text-xs">
                  仅非流式
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs
              value={heroScope}
              onValueChange={(v) => {
                setHeroScope(v as "all" | "pre_first" | "gateway");
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">
                  全链路
                </TabsTrigger>
                <TabsTrigger value="pre_first" className="text-xs">
                  首字前链路
                </TabsTrigger>
                <TabsTrigger value="gateway" className="text-xs">
                  仅网关内部
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        }
      >
        <StackedBarChart
          height={240}
          data={buckets.map((b) => {
            const ttftWait = Math.max(0, b.avgTtftMs - b.avgUpstreamHeaderMs);
            const values: Record<string, number> =
              heroScope === "gateway"
                ? { routing: b.avgRoutingMs, prep: b.avgAttemptPrepMs }
                : heroScope === "pre_first"
                  ? {
                      gateway: b.avgGatewayOverheadMs,
                      header: b.avgUpstreamHeaderMs,
                      wait: ttftWait,
                    }
                  : {
                      gateway: b.avgGatewayOverheadMs,
                      header: b.avgUpstreamHeaderMs,
                      wait: ttftWait,
                      gen: b.avgGenerationMs,
                    };
            return { label: b.label, values };
          })}
          series={
            heroScope === "gateway"
              ? [
                  { key: "routing", label: "路由①~③", color: "#6366F1" },
                  { key: "prep", label: "适配④~⑤", color: "#0EA5E9" },
                ]
              : heroScope === "pre_first"
                ? [
                    { key: "gateway", label: "网关内部", color: "#6366F1" },
                    { key: "header", label: "上游响应头", color: "#14B8A6" },
                    { key: "wait", label: "首字推理等待", color: "#F59E0B" },
                  ]
                : [
                    { key: "gateway", label: "网关内部", color: "#6366F1" },
                    { key: "header", label: "上游响应头", color: "#14B8A6" },
                    { key: "wait", label: "首字推理等待", color: "#F59E0B" },
                    { key: "gen", label: "持续生成耗时", color: "#4B7FFF" },
                  ]
          }
          formatValue={formatMs}
        />
      </ChartCard>

      <SectionGroup title="延时" subtitle="接口延时、首Token延时、非首Token延时三联对比">
        <ChartCard
          title="接口延时"
          helpText="完整请求总耗时（P99 / P90 / P50 / AVG）"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                p99: b.durationP99,
                p90: b.durationP90,
                p50: b.durationP50,
                avg: b.avgTotalDurationMs,
              },
            }))}
            series={[
              { key: "p99", label: "P99", color: "#4B7FFF" },
              { key: "p90", label: "P90", color: "#0EA5E9" },
              { key: "p50", label: "P50", color: "#F59E0B" },
              { key: "avg", label: "AVG", color: "#22C55E" },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>

        <ChartCard
          title="首Token延时"
          helpText="TTFT 首字响应耗时（P99 / P90 / P50 / AVG）"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                p99: b.ttftP99,
                p90: b.ttftP90,
                p50: b.ttftP50,
                avg: b.avgTtftMs,
              },
            }))}
            series={[
              { key: "p99", label: "P99", color: "#4B7FFF" },
              { key: "p90", label: "P90", color: "#0EA5E9" },
              { key: "p50", label: "P50", color: "#F59E0B" },
              { key: "avg", label: "AVG", color: "#22C55E" },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>

        <ChartCard
          title="非首Token延时 (TPOT)"
          helpText="流式输出阶段每 Token 解码间隔 (ms/token)：P99 / P90 / P50 / AVG"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { p99: b.tpotP99, p90: b.tpotP90, p50: b.tpotP50, avg: b.tpotAvg },
            }))}
            series={[
              { key: "p99", label: "P99", color: "#4B7FFF" },
              { key: "p90", label: "P90", color: "#0EA5E9" },
              { key: "p50", label: "P50", color: "#F59E0B" },
              { key: "avg", label: "AVG", color: "#22C55E" },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="网关自身耗时拆解" subtitle="毫秒级独立坐标系观测网关内部与建连开销">
        <ChartCard
          title="网关处理总耗时"
          helpText="入站鉴权 + 脚本路由 + 出站适配总开销 (P99 / P90 / P50 / AVG)"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                p99: b.p99GatewayOverheadMs,
                p90: b.p90GatewayOverheadMs,
                p50: b.p50GatewayOverheadMs,
                avg: b.avgGatewayOverheadMs,
              },
            }))}
            series={[
              { key: "p99", label: "P99", color: "#EF4444", dashed: true },
              { key: "p90", label: "P90", color: "#4B7FFF" },
              { key: "p50", label: "P50", color: "#14B8A6" },
              { key: "avg", label: "AVG", color: "#6366F1", area: true },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>

        <ChartCard
          title="分阶段脚本处理耗时"
          helpText="路由决策阶段 (①~③) 与出站适配阶段 (④~⑤) 耗时均值"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { routing: b.avgRoutingMs, prep: b.avgAttemptPrepMs },
            }))}
            series={[
              { key: "routing", label: "路由①~③", color: "#6366F1", area: true },
              { key: "prep", label: "适配④~⑤", color: "#0EA5E9" },
            ]}
            formatValue={formatMs}
          />
        </ChartCard>

        <ChartCard
          title="上游 HTTP 响应头延时"
          helpText="网关发出请求后到收到上游 HTTP 状态行/响应头的网络与排队时间"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { header: b.avgUpstreamHeaderMs },
            }))}
            series={[{ key: "header", label: "Header TTFB", color: "#14B8A6", area: true }]}
            formatValue={formatMs}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="生成吞吐与实体对比" subtitle="Decode / E2E 速率、延时直方图、象限与流式差异">
        <ChartCard
          title="Decode 生成速率"
          helpText="净生成吞吐 (AVG / P50 / P90 tokens/s)"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { avg: b.decodeTpsAvg, p50: b.decodeTpsP50, p90: b.decodeTpsP90 },
            }))}
            series={[
              { key: "avg", label: "AVG", color: "#4B7FFF", area: true },
              { key: "p50", label: "P50", color: "#14B8A6" },
              { key: "p90", label: "P90", color: "#6366F1" },
            ]}
            formatValue={(v) => `${v.toFixed(1)} t/s`}
          />
        </ChartCard>

        <ChartCard
          title="E2E TPS vs Decode TPS"
          helpText="对比端到端吞吐与净解码吞吐，观察首字等待造成的速率折损"
          loading={loading}
          empty={!hasPerf}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { decode: b.decodeTpsAvg, e2e: b.avgE2eTps },
            }))}
            series={[
              { key: "decode", label: "Decode TPS", color: "#4B7FFF" },
              { key: "e2e", label: "E2E TPS", color: "#F59E0B", area: true },
            ]}
            formatValue={(v) => `${v.toFixed(1)} t/s`}
          />
        </ChartCard>

        <ChartCard
          title="首Token延时区间分布"
          helpText="TTFT 落在不同耗时分桶的请求数量"
          loading={loading}
          empty={histogram.every((h) => h.count === 0)}
        >
          <HorizontalBarChart
            items={histogram.map((h) => ({
              key: h.name,
              label: h.name,
              value: h.count,
              color: "#4B7FFF",
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="模型性能象限对比"
          helpText="平均首字延时（横轴）与生成速率（纵轴）散点"
          loading={loading}
          empty={quadrant.length === 0}
        >
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

        <ChartCard
          title="供应商生成速率排行"
          helpText="各供应商实测平均 Decode TPS 对比"
          loading={loading}
          empty={providerBench.length === 0}
        >
          <HorizontalBarChart
            items={providerBench.map((p) => ({
              key: p.providerId,
              label: p.providerName,
              value: p.avgDecodeTps,
              subLabel: `TTFT ${formatMs(p.avgTtftMs)} · TPOT ${formatMs(p.avgTpotMs)}`,
              color: modelColor(p.providerId),
            }))}
            formatValue={(v) => `${v.toFixed(1)} t/s`}
          />
        </ChartCard>

        <ChartCard
          title="流式 vs 非流式性能对照"
          helpText="对照流式与非流式请求数、平均总耗时与速率"
          loading={loading}
          empty={streamCmp.length === 0}
        >
          <HorizontalBarChart
            items={streamCmp.map((s) => ({
              key: s.mode,
              label: s.mode === "stream" ? "流式 (SSE)" : "非流式 (JSON)",
              value: s.avgTotalDurationMs,
              subLabel: `${formatCompactNumber(s.requestCount)} 次 · TTFT ${formatMs(s.avgTtftMs)}`,
              color: s.mode === "stream" ? "#4B7FFF" : "#14B8A6",
            }))}
            formatValue={formatMs}
          />
        </ChartCard>
      </SectionGroup>
    </div>
  );
}

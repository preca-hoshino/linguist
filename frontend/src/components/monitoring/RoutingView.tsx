import { modelColor } from "../../api/client";
import { formatCompactNumber, formatMs } from "../../api/monitoring";
import type { RouteRuleStat, RoutingMonitoringResponse } from "../../types/monitoring";
import { ChartCard } from "../charts/ChartCard";
import { DonutChart } from "../charts/DonutChart";
import { HorizontalBarChart } from "../charts/HorizontalBarChart";
import { LineAreaChart } from "../charts/LineAreaChart";
import { MiniTableCard } from "../charts/MiniTableCard";
import type { MiniTableColumn } from "../charts/MiniTableCard";
import { SectionGroup } from "../charts/SectionGroup";
import { StackedBarChart } from "../charts/StackedBarChart";
import { StatKpiCard } from "../charts/StatKpiCard";

interface RoutingViewProps {
  data: RoutingMonitoringResponse | null;
  loading: boolean;
}

const RULE_COLUMNS: MiniTableColumn<RouteRuleStat>[] = [
  {
    key: "ruleId",
    label: "路由规则",
    render: (r) => <span className="mono">{r.ruleId || "(默认)"}</span>,
  },
  {
    key: "requests",
    label: "命中次数",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.requestCount)}</span>,
  },
  {
    key: "share",
    label: "流量占比",
    align: "right",
    render: (r) => <span className="mono">{r.sharePercent.toFixed(1)}%</span>,
  },
  {
    key: "endpoints",
    label: "目标端点数",
    align: "right",
    render: (r) => <span className="mono">{r.endpointCount}</span>,
  },
  {
    key: "firstTry",
    label: "直连成功率",
    align: "right",
    render: (r) => <span className="mono">{r.firstTryRate.toFixed(1)}%</span>,
  },
  {
    key: "fallback",
    label: "Fallback 触发率",
    align: "right",
    render: (r) => <span className="mono">{r.fallbackRate.toFixed(2)}%</span>,
  },
  {
    key: "routingMs",
    label: "平均路由耗时",
    align: "right",
    render: (r) => <span className="mono">{formatMs(r.avgRoutingMs)}</span>,
  },
  {
    key: "durationMs",
    label: "平均总耗时",
    align: "right",
    render: (r) => <span className="mono">{formatMs(r.avgDurationMs)}</span>,
  },
];

export function RoutingView({ data, loading }: RoutingViewProps) {
  const buckets = data?.buckets ?? [];
  const summary = data?.summary;
  const ruleKeys = data?.ruleSeriesKeys ?? [];
  const ruleStats = data?.ruleStats ?? [];
  const providerStats = data?.providerStats ?? [];
  const finishReasons = data?.finishReasons ?? [];
  const streamSplit = data?.streamSplit ?? { streamCount: 0, nonStreamCount: 0 };
  const attemptDist = data?.attemptDistribution ?? [];
  const mappings = data?.callModelMappings ?? [];
  const tokenSources = data?.tokenSources ?? [];
  const hasRouting = buckets.some((b) => b.status2xx + b.status4xx + b.status5xx + b.statusOther > 0);

  return (
    <>
      <div className="monitoring-kpi-strip">
        <StatKpiCard
          title="活跃命中规则数"
          value={String(summary?.activeRules ?? 0)}
          helpText="当前时间窗口内被匹配命中的不同路由规则数量"
          tone="blue"
        />
        <StatKpiCard
          title="首次直连成功率"
          value={`${(summary?.firstTrySuccessRate ?? 0).toFixed(2)}%`}
          helpText="attempt_index = 1 且返回 2xx 的比例"
          tone="green"
        />
        <StatKpiCard
          title="Fallback 挽回成功"
          value={formatCompactNumber(summary?.retrySuccessCount ?? 0)}
          subValue={`重试挽回率 ${(summary?.retryRecoveryRate ?? 0).toFixed(1)}%`}
          helpText="主目标失败后经 Fallback 重试最终成功的请求数及挽回比例"
          tone="amber"
        />
        <StatKpiCard
          title="流式请求占比"
          value={`${(summary?.streamRate ?? 0).toFixed(1)}%`}
          subValue={`流式 ${formatCompactNumber(streamSplit.streamCount)} · 非流式 ${formatCompactNumber(streamSplit.nonStreamCount)}`}
          helpText="SSE 流式调用占比"
        />
      </div>

      <ChartCard
        fullWidth
        title="路由规则调度绩效明细"
        helpText="各路由规则的流量分布、目标端点数、直连成功率、Fallback 比例与路由处理耗时"
        loading={loading}
        empty={ruleStats.length === 0}
        expandable={false}
      >
        <MiniTableCard
          columns={RULE_COLUMNS}
          rows={ruleStats}
          rowKey={(r) => r.ruleId}
        />
      </ChartCard>

      <SectionGroup title="规则分流与供应商承接" subtitle="路由命中走势、供应商承接规模与可靠性分离展示">
        <ChartCard title="路由规则分流趋势" loading={loading} empty={!hasRouting || ruleKeys.length === 0}>
          <StackedBarChart
            data={buckets.map((b) => ({ label: b.label, values: b.ruleCounts }))}
            series={ruleKeys.map((k) => ({
              key: k,
              label: k,
              color: k === "其他" ? "#94A3B8" : modelColor(k),
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="供应商请求承接量" helpText="各供应商承接的请求尝试次数" loading={loading} empty={providerStats.length === 0}>
          <HorizontalBarChart
            items={providerStats.map((p) => ({
              key: p.providerId,
              label: p.providerName,
              value: p.requestCount,
              subLabel: `失败 ${p.errorCount}`,
              color: modelColor(p.providerId),
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="供应商成功率对比" helpText="各供应商 HTTP 2xx/3xx 成功率" loading={loading} empty={providerStats.length === 0}>
          <HorizontalBarChart
            items={providerStats.map((p) => ({
              key: p.providerId,
              label: p.providerName,
              value: p.successRate,
              subLabel: `${formatCompactNumber(p.requestCount)} 次`,
              color: p.successRate >= 98 ? "#22C55E" : p.successRate >= 90 ? "#F59E0B" : "#EF4444",
            }))}
            formatValue={(v) => `${v.toFixed(2)}%`}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="容灾恢复与映射落点" subtitle="放大观察 Fallback 重试链路及调用模型最终落点">
        <ChartCard
          title="Fallback 重试挽回 vs 最终失败"
          helpText="剥离首次直连成功，独立放大重试挽回成功数与最终失败数趋势"
          loading={loading}
          empty={!hasRouting}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { retryOk: b.retrySuccess, failed: b.finalError },
            }))}
            series={[
              { key: "retryOk", label: "Fallback 挽回", color: "#F59E0B", area: true },
              { key: "failed", label: "最终失败", color: "#EF4444" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="Attempt 尝试次数分布" helpText="1 次直连 vs 2 次 / 3 次以上重试占比" loading={loading} empty={!hasRouting}>
          <DonutChart
            slices={attemptDist.map((a, idx) => ({
              key: a.name,
              label: a.name,
              value: a.count,
              color: idx === 0 ? "#22C55E" : idx === 1 ? "#F59E0B" : "#EF4444",
            }))}
            centerLabel="尝试次数"
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="调用模型 → 实际目标模型 Top" helpText="调用侧 call_model_id 最终路由到的上游模型分布" loading={loading} empty={mappings.length === 0}>
          <HorizontalBarChart
            items={mappings.map((m) => ({
              key: `${m.callModelId}->${m.providerId}/${m.modelId}`,
              label: `${m.callModelId} → ${m.modelName}`,
              value: m.requestCount,
              subLabel: m.providerId,
              color: modelColor(`${m.providerId}/${m.modelId}`),
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="协议与响应结束形态" subtitle="独立拆解 finish_reason、流式模式与 Token 统计来源">
        <ChartCard title="结束原因 (finish_reason) 分布" loading={loading} empty={finishReasons.length === 0}>
          <DonutChart
            slices={finishReasons.map((r) => ({
              key: r.name,
              label: r.name,
              value: r.count,
              color: modelColor(`reason-${r.name}`),
            }))}
            centerLabel="结束原因"
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="流式 vs 非流式分布" loading={loading} empty={streamSplit.streamCount + streamSplit.nonStreamCount === 0}>
          <DonutChart
            slices={[
              { key: "stream", label: "流式 (SSE)", value: streamSplit.streamCount, color: "#4B7FFF" },
              { key: "non_stream", label: "非流式 (JSON)", value: streamSplit.nonStreamCount, color: "#14B8A6" },
            ]}
            centerLabel="传输模式"
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="Token 统计来源" helpText="upstream_usage（上游实报）vs fallback_estimated（断流估算）" loading={loading} empty={tokenSources.length === 0}>
          <DonutChart
            slices={tokenSources.map((t) => ({
              key: t.name,
              label: t.name,
              value: t.count,
              color: t.name === "upstream_usage" ? "#22C55E" : t.name === "fallback_estimated" ? "#F59E0B" : "#EF4444",
            }))}
            centerLabel="统计来源"
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>
    </>
  );
}

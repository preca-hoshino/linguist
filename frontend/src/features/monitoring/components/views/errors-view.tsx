import { useNavigate } from "react-router";
import { modelColor } from "@/features/dashboard/api";
import { formatCompactNumber, formatMs } from "../../api";
import type { ErrorDetailRow, ErrorsMonitoringResponse } from "../../types";
import { ChartCard } from "../chart-card";
import { ComboChart } from "../charts/combo-chart";
import { DonutChart } from "../charts/donut-chart";
import { HorizontalBarChart } from "../charts/horizontal-bar-chart";
import { LineAreaChart } from "../charts/line-area-chart";
import { StackedBarChart } from "../charts/stacked-bar-chart";
import { MiniTableCard, type MiniTableColumn } from "../mini-table-card";
import { SectionGroup } from "../section-group";
import { StatKpiCard } from "../stat-kpi-card";

interface ErrorsViewProps {
  data: ErrorsMonitoringResponse | null;
  loading: boolean;
}

const ERROR_COLUMNS: MiniTableColumn<ErrorDetailRow>[] = [
  {
    key: "provider",
    label: "供应商",
    render: (r) => r.providerName || r.providerId,
  },
  {
    key: "model",
    label: "模型",
    render: (r) => r.modelName || r.modelId,
  },
  {
    key: "rule",
    label: "路由规则",
    render: (r) => <span className="mono">{r.routeRuleId || "—"}</span>,
  },
  {
    key: "status",
    label: "HTTP 状态码",
    align: "right",
    render: (r) => <span className="mono">{r.statusCode}</span>,
  },
  {
    key: "snippet",
    label: "错误摘要",
    render: (r) => (
      <span
        className="mono inline-block max-w-64 truncate align-bottom"
        title={r.errorSnippet}
      >
        {r.errorSnippet}
      </span>
    ),
  },
  {
    key: "count",
    label: "数量",
    align: "right",
    render: (r) => <span className="mono">{formatCompactNumber(r.count)}</span>,
  },
  {
    key: "share",
    label: "占比",
    align: "right",
    render: (r) => <span className="mono">{r.sharePercent.toFixed(1)}%</span>,
  },
  {
    key: "lastSeen",
    label: "最近发生",
    align: "right",
    render: (r) => (
      <span className="mono">{new Date(r.lastSeen).toLocaleString("zh-CN", { hour12: false })}</span>
    ),
  },
];

export function ErrorsView({ data, loading }: ErrorsViewProps) {
  const navigate = useNavigate();
  const summary = data?.summary;
  const buckets = data?.buckets ?? [];
  const details = data?.errorDetails ?? [];
  const byProvider = data?.byProvider ?? [];
  const byModel = data?.byModel ?? [];
  const byProject = data?.byProject ?? [];
  const statusBreakdown = data?.statusBreakdown ?? [];
  const hasErrors = (summary?.totalErrors ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatKpiCard
          title="总异常请求数"
          value={formatCompactNumber(summary?.totalErrors ?? 0)}
          subValue={`总请求 ${formatCompactNumber(summary?.totalRequests ?? 0)}`}
          helpText="HTTP 状态码 >= 400 或 < 200 的异常请求总数"
          tone={hasErrors ? "red" : "green"}
        />
        <StatKpiCard
          title="整体错误率"
          value={`${(summary?.errorRate ?? 0).toFixed(2)}%`}
          helpText="异常请求数 / 总请求数"
          tone={
            (summary?.errorRate ?? 0) >= 5
              ? "red"
              : (summary?.errorRate ?? 0) > 0
                ? "amber"
                : "green"
          }
        />
        <StatKpiCard
          title="限流错误详情 (429)"
          value={formatCompactNumber(summary?.rateLimitCount ?? 0)}
          subValue={`限流错误率 ${(summary?.rateLimitRate ?? 0).toFixed(2)}%`}
          helpText="上游返回 HTTP 429 Rate Limit 次数及占比"
          tone={(summary?.rateLimitCount ?? 0) > 0 ? "amber" : "green"}
        />
        <StatKpiCard
          title="超时 / 5xx 错误"
          value={formatCompactNumber(summary?.timeoutOr5xxCount ?? 0)}
          subValue={`占比 ${(summary?.timeoutOr5xxRate ?? 0).toFixed(2)}%`}
          helpText="502 建连/超时及其他 5xx 上游故障总数"
          tone={(summary?.timeoutOr5xxCount ?? 0) > 0 ? "red" : "green"}
        />
        <StatKpiCard
          title="SSE 断流中断"
          value={formatCompactNumber(summary?.sseInterruptedCount ?? 0)}
          helpText="流式传输中途断开或降级估算的请求数"
          tone={(summary?.sseInterruptedCount ?? 0) > 0 ? "amber" : "green"}
        />
      </div>

      <ChartCard
        fullWidth
        title="错误详情"
        helpText="聚合供应商、模型、HTTP 状态码与错误信息摘要；点击行可跳转请求日志页排查"
        loading={loading}
        empty={details.length === 0}
        emptyText="当前筛选窗口内无异常记录"
        expandable={false}
      >
        <MiniTableCard
          columns={ERROR_COLUMNS}
          rows={details}
          rowKey={(r, idx) => `${r.providerId}-${r.modelId}-${r.statusCode}-${idx}`}
          onRowClick={() => {
            void navigate("/logs");
          }}
        />
      </ChartCard>

      <SectionGroup title="异常统计" subtitle="错误率曲线、错误码速率及限流/超时独立趋势">
        <ChartCard
          title="错误率"
          helpText="全周期异常率 % 波动曲线"
          loading={loading}
          empty={buckets.length === 0}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { rate: b.errorRate },
            }))}
            series={[{ key: "rate", label: "错误率", color: "#EF4444", area: true }]}
            formatValue={(v) => `${v.toFixed(2)}%`}
          />
        </ChartCard>

        <ChartCard
          title="错误码速率"
          helpText="按 429 限流、502 建连、其他 4xx、其他 5xx 细分错码次数（剥离 2xx 干扰）"
          loading={loading}
          empty={!hasErrors}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                s429: b.status429,
                s502: b.status502,
                s4xx: b.status4xxOther,
                s5xx: b.status5xxOther,
              },
            }))}
            series={[
              { key: "s429", label: "429 限流", color: "#F59E0B" },
              { key: "s502", label: "502 网关/建连", color: "#EF4444" },
              { key: "s4xx", label: "其他 4xx", color: "#6366F1" },
              { key: "s5xx", label: "其他 5xx", color: "#EC4899" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="异常请求平均耗时"
          helpText="判断是秒级快速拒签 (~100ms) 还是等满超时才失败"
          loading={loading}
          empty={!hasErrors}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { dur: b.avgErrorDurationMs },
            }))}
            series={[{ key: "dur", label: "平均失败耗时", color: "#EF4444", area: true }]}
            formatValue={formatMs}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="故障维度归因" subtitle="定位报错最多的供应商、模型与调用项目">
        <ChartCard title="按供应商异常排行" loading={loading} empty={byProvider.length === 0}>
          <HorizontalBarChart
            items={byProvider.map((p) => ({
              key: p.id,
              label: p.name,
              value: p.errorCount,
              subLabel: `错误率 ${p.errorRate.toFixed(1)}%`,
              color: "#EF4444",
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="按模型异常排行" loading={loading} empty={byModel.length === 0}>
          <HorizontalBarChart
            items={byModel.map((m) => ({
              key: m.id,
              label: m.name,
              value: m.errorCount,
              subLabel: `错误率 ${m.errorRate.toFixed(1)}%`,
              color: modelColor(m.id),
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="按项目异常排行" loading={loading} empty={byProject.length === 0}>
          <HorizontalBarChart
            items={byProject.map((p) => ({
              key: p.id,
              label: p.name,
              value: p.errorCount,
              subLabel: `错误率 ${p.errorRate.toFixed(1)}%`,
              color: "#F59E0B",
            }))}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="错码构成与容灾挽回" subtitle="状态码占比分布及 Fallback 挽回对照">
        <ChartCard
          title="错误状态码分布"
          loading={loading}
          empty={statusBreakdown.every((s) => s.count === 0)}
        >
          <DonutChart
            slices={statusBreakdown.map((s) => ({
              key: s.name,
              label: s.name,
              value: s.count,
              color: s.name.includes("429")
                ? "#F59E0B"
                : s.name.includes("502")
                  ? "#EF4444"
                  : s.name.includes("4xx")
                    ? "#6366F1"
                    : "#EC4899",
            }))}
            centerLabel="异常总计"
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="限流(429) vs 建连/5xx 堆叠" loading={loading} empty={!hasErrors}>
          <StackedBarChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                s429: b.status429,
                s502: b.status502,
                s5xx: b.status5xxOther,
              },
            }))}
            series={[
              { key: "s429", label: "429 限流", color: "#F59E0B" },
              { key: "s502", label: "502 建连失败", color: "#EF4444" },
              { key: "s5xx", label: "其他 5xx", color: "#EC4899" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="最终失败 vs Fallback 挽回"
          helpText="展示最终失败数（柱）与同期请求错误率（线）"
          loading={loading}
          empty={buckets.length === 0}
        >
          <ComboChart
            data={buckets.map((b) => ({
              label: b.label,
              barValue: b.finalError,
              lineValue: b.errorRate,
            }))}
            barLabel="异常数"
            lineLabel="错误率"
            barColor="#FCA5A5"
            lineColor="#EF4444"
            formatBar={formatCompactNumber}
            formatLine={(v) => `${v.toFixed(1)}%`}
          />
        </ChartCard>
      </SectionGroup>
    </div>
  );
}

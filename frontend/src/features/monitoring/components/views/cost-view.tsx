import { useState } from "react";
import { modelColor } from "@/features/dashboard/api";
import { formatCompactNumber, formatMoney } from "../../api";
import type { CostDetailRow, CostMonitoringResponse } from "../../types";
import { ChartCard } from "../chart-card";
import { DonutChart } from "../charts/donut-chart";
import { HorizontalBarChart } from "../charts/horizontal-bar-chart";
import { LineAreaChart } from "../charts/line-area-chart";
import { StackedBarChart } from "../charts/stacked-bar-chart";
import { MiniTableCard, type MiniTableColumn } from "../mini-table-card";
import { SectionGroup } from "../section-group";
import { StatKpiCard } from "../stat-kpi-card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface CostViewProps {
  data: CostMonitoringResponse | null;
  loading: boolean;
}

export function CostView({ data, loading }: CostViewProps) {
  const [tableGroup, setTableGroup] = useState<"model" | "project" | "provider">("model");

  const buckets = data?.buckets ?? [];
  const currency = data?.currency ?? null;
  const summary = data?.summary;
  const comp = data?.componentTotals;
  const seriesKeys = data?.seriesKeys ?? [];
  const projSeriesKeys = data?.projectSeriesKeys ?? [];
  const rankByProject = data?.rankByProject ?? [];
  const rankByModel = data?.rankByModel ?? [];
  const rankByProvider = data?.rankByProvider ?? [];
  const billingStatus = data?.billingStatusCounts ?? [];
  const detailRows = (data?.detailRows ?? []).filter((r) => r.groupBy === tableGroup);

  const hasCost = buckets.some((b) => b.totalAmount > 0);
  const fmtCost = (v: number) => formatMoney(v, currency);
  const currencyTotals = Array.isArray(summary?.currencyTotals) ? summary.currencyTotals : [];
  const rawCurrenciesSub = currencyTotals.length
    ? currencyTotals.map((c) => formatMoney(c.amount, c.currency)).join(" · ")
    : "—";

  const columns: MiniTableColumn<CostDetailRow>[] = [
    { key: "name", label: "名称", render: (r) => r.name },
    {
      key: "total",
      label: "总消费",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.totalAmount)}</span>,
    },
    {
      key: "share",
      label: "占比",
      align: "right",
      render: (r) => <span className="mono">{r.sharePercent.toFixed(1)}%</span>,
    },
    {
      key: "input",
      label: "输入费",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.inputAmount)}</span>,
    },
    {
      key: "output",
      label: "输出费",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.outputAmount)}</span>,
    },
    {
      key: "cache",
      label: "缓存读/写费",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.cacheAmount)}</span>,
    },
    {
      key: "other",
      label: "其他/存储费",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.otherAmount)}</span>,
    },
    {
      key: "per1m",
      label: "每 1M 单价",
      align: "right",
      render: (r) => <span className="mono">{fmtCost(r.costPer1mTokens)}</span>,
    },
    {
      key: "reqs",
      label: "请求 / 未定价",
      align: "right",
      render: (r) => (
        <span className="mono">
          {formatCompactNumber(r.requestCount)} / {r.unpricedCount}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatKpiCard
          title="周期总消费"
          value={fmtCost(summary?.totalAmount ?? 0)}
          subValue={`原币种: ${rawCurrenciesSub}`}
          helpText="按显示币种折算后的周期总消费金额"
          tone="blue"
        />
        <StatKpiCard
          title="每百万 Token 综合单价"
          value={fmtCost(summary?.costPer1mTokens ?? 0)}
          helpText="周期总消费 / 已计价总 Token × 1,000,000"
        />
        <StatKpiCard
          title="单次请求平均成本"
          value={fmtCost(summary?.avgCostPerRequest ?? 0)}
          subValue={`已计价 ${formatCompactNumber(summary?.pricedCount ?? 0)} 次`}
          helpText="周期总消费 / 已计价请求数"
        />
        <StatKpiCard
          title="计价覆盖率"
          value={`${(summary?.coverageRate ?? 0).toFixed(1)}%`}
          subValue={`未定价 ${summary?.unpricedCount ?? 0} · 脚本错误 ${summary?.scriptErrorCount ?? 0}`}
          helpText="成功完成计价的请求比例"
          tone={(summary?.scriptErrorCount ?? 0) > 0 ? "amber" : "green"}
        />
      </div>

      <ChartCard
        fullWidth
        title="多维消费核算明细"
        helpText="按模型、项目或供应商拆分输入、输出、缓存与附加存储费用"
        loading={loading}
        empty={detailRows.length === 0}
        expandable={false}
        controls={
          <Tabs
            value={tableGroup}
            onValueChange={(v) => {
              setTableGroup(v as "model" | "project" | "provider");
            }}
          >
            <TabsList className="h-8">
              <TabsTrigger value="model" className="text-xs">
                按模型
              </TabsTrigger>
              <TabsTrigger value="project" className="text-xs">
                按项目
              </TabsTrigger>
              <TabsTrigger value="provider" className="text-xs">
                按供应商
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <MiniTableCard
          columns={columns}
          rows={detailRows}
          rowKey={(r) => `${r.groupBy}-${r.id}`}
        />
      </ChartCard>

      <SectionGroup title="消费趋势与结构" subtitle="按模型、按项目、按费用项拆分趋势">
        <ChartCard
          title="按模型消费趋势"
          loading={loading}
          empty={!hasCost || seriesKeys.length === 0}
        >
          <StackedBarChart
            data={buckets.map((b) => ({ label: b.label, values: b.byModel }))}
            series={seriesKeys.map((s) => ({
              key: s.key,
              label: s.name,
              color: s.key === "__other__" ? "#94A3B8" : modelColor(s.key),
            }))}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard
          title="按项目消费趋势"
          loading={loading}
          empty={!hasCost || projSeriesKeys.length === 0}
        >
          <StackedBarChart
            data={buckets.map((b) => ({ label: b.label, values: b.byProject }))}
            series={projSeriesKeys.map((s) => ({
              key: s.key,
              label: s.name,
              color: s.key === "__other__" ? "#94A3B8" : modelColor(s.key),
            }))}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard
          title="费用构成堆叠趋势"
          helpText="输入、输出、缓存读/写与存储/附加费"
          loading={loading}
          empty={!hasCost}
        >
          <StackedBarChart
            data={buckets.map((b) => ({
              label: b.label,
              values: {
                input: b.inputAmount,
                output: b.outputAmount,
                cacheRead: b.cacheReadAmount,
                cacheWrite: b.cacheWriteAmount,
                other: b.otherAmount,
              },
            }))}
            series={[
              { key: "input", label: "输入费", color: "#4B7FFF" },
              { key: "output", label: "输出费", color: "#14B8A6" },
              { key: "cacheRead", label: "缓存读", color: "#6366F1" },
              { key: "cacheWrite", label: "缓存写", color: "#F59E0B" },
              { key: "other", label: "其他费", color: "#94A3B8" },
            ]}
            formatValue={fmtCost}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="单位效能与构成占比" subtitle="独立坐标系拆开每百万单价与单次请求均价">
        <ChartCard
          title="每 1M Token 成本趋势"
          helpText="独立 Y 轴单位：货币/1M tokens"
          loading={loading}
          empty={!hasCost}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { per1m: b.costPer1mTokens },
            }))}
            series={[{ key: "per1m", label: "每 1M Token 成本", color: "#4B7FFF", area: true }]}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard
          title="单次请求均价趋势"
          helpText="独立 Y 轴单位：货币/请求"
          loading={loading}
          empty={!hasCost}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { perReq: b.avgCostPerRequest },
            }))}
            series={[{ key: "perReq", label: "单次请求均价", color: "#F59E0B", area: true }]}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard title="费用构成总占比" loading={loading} empty={!hasCost}>
          <DonutChart
            slices={[
              { key: "input", label: "输入费", value: comp?.inputAmount ?? 0, color: "#4B7FFF" },
              { key: "output", label: "输出费", value: comp?.outputAmount ?? 0, color: "#14B8A6" },
              {
                key: "cacheRead",
                label: "缓存读",
                value: comp?.cacheReadAmount ?? 0,
                color: "#6366F1",
              },
              {
                key: "cacheWrite",
                label: "缓存写",
                value: comp?.cacheWriteAmount ?? 0,
                color: "#F59E0B",
              },
              { key: "other", label: "其他/存储", value: comp?.otherAmount ?? 0, color: "#94A3B8" },
            ]}
            centerLabel="累计构成"
            formatValue={fmtCost}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="消费排行与计费覆盖" subtitle="项目、模型、供应商三列排行与计费状态分布">
        <ChartCard title="按项目消费 Top 10" loading={loading} empty={rankByProject.length === 0}>
          <HorizontalBarChart
            items={rankByProject.map((item) => ({
              key: item.id,
              label: item.name,
              value: item.amount,
              subLabel:
                item.unpricedCount > 0 ? `${item.unpricedCount} 未定价` : `${item.requestCount} 次`,
              color: modelColor(item.id),
            }))}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard title="按模型消费 Top 10" loading={loading} empty={rankByModel.length === 0}>
          <HorizontalBarChart
            items={rankByModel.map((item) => ({
              key: item.id,
              label: item.name,
              value: item.amount,
              subLabel:
                item.unpricedCount > 0 ? `${item.unpricedCount} 未定价` : `${item.requestCount} 次`,
              color: modelColor(item.id),
            }))}
            formatValue={fmtCost}
          />
        </ChartCard>

        <ChartCard
          title="按供应商消费 & 计费状态"
          loading={loading}
          empty={rankByProvider.length === 0 && billingStatus.length === 0}
        >
          <div className="space-y-4">
            <HorizontalBarChart
              items={rankByProvider.slice(0, 5).map((item) => ({
                key: item.id,
                label: item.name,
                value: item.amount,
                subLabel: `${item.requestCount} 次`,
                color: modelColor(item.id),
              }))}
              formatValue={fmtCost}
            />
            <DonutChart
              slices={billingStatus.map((s) => ({
                key: s.name,
                label: s.name,
                value: s.count,
                color:
                  s.name === "priced"
                    ? "#22C55E"
                    : s.name === "unpriced"
                      ? "#94A3B8"
                      : s.name === "script_error"
                        ? "#EF4444"
                        : "#F59E0B",
              }))}
              centerLabel="计费状态"
              formatValue={formatCompactNumber}
            />
          </div>
        </ChartCard>
      </SectionGroup>
    </div>
  );
}

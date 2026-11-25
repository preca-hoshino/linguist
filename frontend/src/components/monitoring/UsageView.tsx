import { useState } from "react";
import { modelColor } from "../../api/client";
import { formatCompactNumber } from "../../api/monitoring";
import type { TrafficMonitoringResponse } from "../../types/monitoring";
import { ChartCard } from "../charts/ChartCard";
import { DonutChart } from "../charts/DonutChart";
import { LineAreaChart } from "../charts/LineAreaChart";
import { SectionGroup } from "../charts/SectionGroup";
import { StackedBarChart } from "../charts/StackedBarChart";
import { StatKpiCard } from "../charts/StatKpiCard";

interface UsageViewProps {
  data: TrafficMonitoringResponse | null;
  loading: boolean;
}

export function UsageView({ data, loading }: UsageViewProps) {
  const [heroMode, setHeroMode] = useState<"tpm" | "volume">("tpm");
  const [distMetric, setDistMetric] = useState<"totalTokens" | "requestCount">("totalTokens");
  const [supplyDim, setSupplyDim] = useState<"provider" | "callModel">("provider");

  const buckets = data?.buckets ?? [];
  const totals = data?.totals;
  const hasTraffic = buckets.some((b) => b.totalRequests > 0);
  const supplySlices = supplyDim === "provider"
    ? (data?.distributionByProvider ?? [])
    : (data?.distributionByCallModel ?? []);

  return (
    <>
      <div className="monitoring-kpi-strip">
        <StatKpiCard
          title="总请求数"
          value={formatCompactNumber(totals?.totalRequests ?? 0)}
          subValue={`平均 ${(totals?.avgRpm ?? 0).toFixed(2)} req/m`}
          helpText="当前时间窗口内落库的总请求尝试数及平均每分钟请求速率 (RPM)"
          tone="blue"
        />
        <StatKpiCard
          title="总消耗 Token"
          value={formatCompactNumber(totals?.totalTokens ?? 0)}
          subValue={`输入 ${formatCompactNumber(totals?.inputTokens ?? 0)} · 输出 ${formatCompactNumber(totals?.outputTokens ?? 0)}`}
          helpText="输入与输出 Token 累计消耗量"
        />
        <StatKpiCard
          title="缓存命中数量 (Tokens)"
          value={formatCompactNumber(totals?.cacheReadTokens ?? 0)}
          subValue={`缓存写入 ${formatCompactNumber(totals?.cacheCreationTokens ?? 0)}`}
          helpText="Prompt Cache 命中的 Token 总量与缓存写入总量"
          tone="green"
        />
        <StatKpiCard
          title="缓存命中率"
          value={`${(totals?.cacheHitRate ?? 0).toFixed(1)}%`}
          subValue={`推理 ${formatCompactNumber(totals?.reasoningTokens ?? 0)} · 扩展 ${formatCompactNumber(totals?.extraTokens ?? 0)}`}
          helpText="缓存读取 Token / (输入 Token + 缓存读取 Token)"
        />
      </div>

      <ChartCard
        fullWidth
        title="Token 速率与总量趋势"
        helpText="展示输入、输出与总 Token 的每分钟速率 (TPM) 或分桶绝对消耗量"
        loading={loading}
        empty={!hasTraffic}
        controls={(
          <div className="segmented-group">
            <button type="button" className={`segmented-btn${heroMode === "tpm" ? " active" : ""}`} onClick={() => { setHeroMode("tpm"); }}>
              Token速率 (TPM)
            </button>
            <button type="button" className={`segmented-btn${heroMode === "volume" ? " active" : ""}`} onClick={() => { setHeroMode("volume"); }}>
              分桶总量
            </button>
          </div>
        )}
      >
        <LineAreaChart
          height={235}
          data={buckets.map((b) => ({
            label: b.label,
            values: heroMode === "tpm"
              ? { total: b.tpmTotal, input: b.tpmIn, output: b.tpmOut }
              : { total: b.inputTokens + b.outputTokens, input: b.inputTokens, output: b.outputTokens },
          }))}
          series={[
            { key: "total", label: "Total", color: "#F59E0B", area: true },
            { key: "input", label: "In", color: "#4B7FFF" },
            { key: "output", label: "Out", color: "#0EA5E9" },
          ]}
          formatValue={formatCompactNumber}
        />
      </ChartCard>

      <SectionGroup title="用量" subtitle="请求速率、单次负载与输入长度分档速率">
        <ChartCard
          title="接口RPM (Requests per Minute)"
          helpText="每分钟平均请求次数，独立剥离异常曲线避免视觉挤压"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { rpm: b.rpm },
            }))}
            series={[{ key: "rpm", label: "RPM", color: "#4B7FFF", area: true }]}
            formatValue={(v) => `${v.toFixed(1)} req/m`}
          />
        </ChartCard>

        <ChartCard
          title="单次请求tokens输入数量"
          helpText="每次请求 Prompt 输入 Token 的平均值与 P90 分位（独立量纲）"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { avg: b.avgInputTokens, p90: b.p90InputTokens },
            }))}
            series={[
              { key: "avg", label: "均值", color: "#4B7FFF", area: true },
              { key: "p90", label: "P90", color: "#0EA5E9", dashed: true },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="单次请求tokens输出数量"
          helpText="每次请求 Completion 输出 Token 的平均值与 P90 分位（独立小量纲轴，不与输入混轴）"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { avg: b.avgOutputTokens, p90: b.p90OutputTokens },
            }))}
            series={[
              { key: "avg", label: "均值", color: "#14B8A6", area: true },
              { key: "p90", label: "P90", color: "#6366F1", dashed: true },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="区间内接口RPM"
          helpText="按单次输入上下文长度分档统计 RPM：0~32K / 32K~128K / 128K+"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { r0: b.rpm032k, r1: b.rpm32k128k, r2: b.rpm128kPlus },
            }))}
            series={[
              { key: "r0", label: "input_0_32k", color: "#4B7FFF" },
              { key: "r1", label: "input_32k_128k", color: "#14B8A6" },
              { key: "r2", label: "input_128k+", color: "#F59E0B" },
            ]}
            formatValue={(v) => `${v.toFixed(1)}/m`}
          />
        </ChartCard>

        <ChartCard
          title="区间内Token速率"
          helpText="按单次输入长度分档统计 Token 速率 (TPM)"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { t0: b.tpm032k, t1: b.tpm32k128k, t2: b.tpm128kPlus },
            }))}
            series={[
              { key: "t0", label: "input_0_32k", color: "#4B7FFF" },
              { key: "t1", label: "input_32k_128k", color: "#14B8A6" },
              { key: "t2", label: "input_128k+", color: "#F59E0B" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="推理思考与扩展 Token"
          helpText="独立展示 reasoning_tokens 与 extra_tokens（避免被百万级输入 Token 淹没）"
          loading={loading}
          empty={!hasTraffic}
        >
          <StackedBarChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { reasoning: b.reasoningTokens, extra: b.extraTokensTotal },
            }))}
            series={[
              { key: "reasoning", label: "推理思考", color: "#F59E0B" },
              { key: "extra", label: "扩展 Token", color: "#EC4899" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup title="推理缓存" subtitle="Prompt Cache 命中体量、读写趋势与命中率">
        <StatKpiCard
          title="缓存命中数量 (Tokens)"
          value={(totals?.cacheReadTokens ?? 0).toLocaleString("en-US")}
          subValue={`缓存写入 ${(totals?.cacheCreationTokens ?? 0).toLocaleString("en-US")} tokens`}
          helpText="当前窗口累计命中推理缓存的 Token 精确总数"
          tone="green"
        />

        <ChartCard
          title="缓存读取 vs 缓存写入趋势"
          helpText="对比上下文缓存读取收益与缓存创建写入量"
          loading={loading}
          empty={!hasTraffic}
        >
          <StackedBarChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { read: b.cacheReadTokens, write: b.cacheCreationTokens },
            }))}
            series={[
              { key: "read", label: "缓存读取", color: "#22C55E" },
              { key: "write", label: "缓存写入", color: "#0EA5E9" },
            ]}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title="缓存命中率"
          helpText="独立 0%~100% 命中率曲线"
          loading={loading}
          empty={!hasTraffic}
        >
          <LineAreaChart
            data={buckets.map((b) => ({
              label: b.label,
              values: { hitRate: b.cacheHitRate },
            }))}
            series={[{ key: "hitRate", label: "命中率", color: "#4B7FFF", area: true }]}
            formatValue={(v) => `${v.toFixed(1)}%`}
          />
        </ChartCard>
      </SectionGroup>

      <SectionGroup
        title="多维用量占比"
        subtitle="模型、项目与供应商同屏对照"
        controls={(
          <div className="segmented-group">
            <button type="button" className={`segmented-btn${distMetric === "totalTokens" ? " active" : ""}`} onClick={() => { setDistMetric("totalTokens"); }}>
              按 Token
            </button>
            <button type="button" className={`segmented-btn${distMetric === "requestCount" ? " active" : ""}`} onClick={() => { setDistMetric("requestCount"); }}>
              按请求数
            </button>
          </div>
        )}
      >
        <ChartCard title="按模型用量分布" loading={loading} empty={(data?.distributionByModel.length ?? 0) === 0}>
          <DonutChart
            slices={(data?.distributionByModel ?? []).map((s) => ({
              key: s.id,
              label: s.name,
              value: s[distMetric],
              color: s.id === "__other__" ? "#94A3B8" : modelColor(s.id),
            }))}
            centerLabel={distMetric === "totalTokens" ? "总 Token" : "总请求"}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard title="按项目用量分布" loading={loading} empty={(data?.distributionByProject.length ?? 0) === 0}>
          <DonutChart
            slices={(data?.distributionByProject ?? []).map((s) => ({
              key: s.id,
              label: s.name,
              value: s[distMetric],
              color: s.id === "__other__" ? "#94A3B8" : modelColor(s.id),
            }))}
            centerLabel={distMetric === "totalTokens" ? "总 Token" : "总请求"}
            formatValue={formatCompactNumber}
          />
        </ChartCard>

        <ChartCard
          title={supplyDim === "provider" ? "按供应商用量分布" : "按调用模型用量分布"}
          loading={loading}
          empty={supplySlices.length === 0}
          controls={(
            <div className="segmented-group">
              <button type="button" className={`segmented-btn${supplyDim === "provider" ? " active" : ""}`} onClick={() => { setSupplyDim("provider"); }}>
                供应商
              </button>
              <button type="button" className={`segmented-btn${supplyDim === "callModel" ? " active" : ""}`} onClick={() => { setSupplyDim("callModel"); }}>
                调用模型
              </button>
            </div>
          )}
        >
          <DonutChart
            slices={supplySlices.map((s) => ({
              key: s.id,
              label: s.name,
              value: s[distMetric],
              color: s.id === "__other__" ? "#94A3B8" : modelColor(s.id),
            }))}
            centerLabel={distMetric === "totalTokens" ? "总 Token" : "总请求"}
            formatValue={formatCompactNumber}
          />
        </ChartCard>
      </SectionGroup>
    </>
  );
}

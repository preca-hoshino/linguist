# src/db/stats — 模型统计分析模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

提供模型网关的统计分析查询，支持多维度（全局/提供商/虚拟模型）和多时间粒度（1 分钟至 30 天）的指标聚合。

## 目录结构

```
stats/
├── types.ts        # 所有统计类型定义（StatsRange / StatsInterval / StatsDimension 等）
├── helpers.ts      # SQL 表达式构建工具（延迟指标、时间过滤、维度过滤、分桶表达式）
├── overview.ts     # getStatsOverview() — 统计概览（请求量、成功率、延迟中位数、Token 总量）
├── time-series.ts  # getStatsTimeSeries() — 时序数据（generate_series 填充空 bucket）
├── errors.ts       # getStatsErrors() — 错误分布统计
├── tokens.ts       # getStatsTokens() — Token 用量统计
├── today.ts        # getStatsToday() — 今日实时指标（含近 1m/5m 滑动窗口）
├── breakdown.ts    # getStatsBreakdown() — 分组占比查询
└── index.ts        # 统一导出
```

## 核心接口

| 函数 | 说明 |
|---|---|
| `getStatsOverview(params)` | 概览聚合：总请求量、成功率、中位延迟、总 Token、平均 TTFT |
| `getStatsTimeSeries(params, interval?)` | 按时间粒度分桶，`generate_series` 填充零值 bucket |
| `getStatsErrors(params)` | 按 error_type 分组的错误计数 |
| `getStatsTokens(params)` | prompt/completion Token 分布 |
| `getStatsToday(params)` | 今日累计 + 近 1m/5m 实时请求率 |
| `getStatsBreakdown(params)` | 按 model/provider 维度的请求量占比 |

## SQL 工具说明（helpers.ts）

| 导出 | 说明 |
|---|---|
| `buildTimeFilter(params, idx)` | 支持 `range`（短窗口：15m/1h/24h 等）和 `from/to`（自定义时间范围）两种模式 |
| `buildDimensionFilter(...)` | 按 `dimension`（global/provider/virtual_model）构建 WHERE 子句 |
| `buildBucketExpr(interval)` | 生成 `date_trunc` / `date_bin` 分桶 SQL 表达式 |
| `autoInterval(range)` | 根据时间范围自动推荐合适粒度（范围越大粒度越粗） |

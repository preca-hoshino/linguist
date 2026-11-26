import { LobeIcon } from "@/components/lobe-icon";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatInteger, modelColor } from "../api";
import type { LeaderboardItem, LeaderboardSort } from "../types";

interface ModelLeaderboardProps {
  items: LeaderboardItem[];
  days: number;
  sort: LeaderboardSort;
  onDaysChange: (days: number) => void;
  onSortChange: (sort: LeaderboardSort) => void;
}

function metricScore(item: LeaderboardItem, sort: LeaderboardSort): number {
  switch (sort) {
    case "avg_decode_tps":
      return item.avgDecodeTps;
    case "p50_decode_tps":
      return item.p50DecodeTps;
    case "p90_decode_tps":
      return item.p90DecodeTps;
    case "avg_ttft_ms":
      return item.avgTtftMs > 0 ? 100_000 / item.avgTtftMs : 0;
  }
}

function primaryMetric(
  item: LeaderboardItem,
  sort: LeaderboardSort,
): { label: string; value: string; unit: string } {
  switch (sort) {
    case "avg_decode_tps":
      return { label: "Avg", value: item.avgDecodeTps.toFixed(1), unit: "tok/s" };
    case "p50_decode_tps":
      return { label: "P50", value: item.p50DecodeTps.toFixed(1), unit: "tok/s" };
    case "p90_decode_tps":
      return { label: "P90", value: item.p90DecodeTps.toFixed(1), unit: "tok/s" };
    case "avg_ttft_ms":
      return { label: "Avg TTFT", value: String(Math.round(item.avgTtftMs)), unit: "ms" };
  }
}

export function ModelLeaderboard({
  items,
  days,
  sort,
  onDaysChange,
  onSortChange,
}: ModelLeaderboardProps) {
  const maxScore = items.reduce((acc, item) => Math.max(acc, metricScore(item, sort)), 0);

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 px-5 py-0">
        <div>
          <CardTitle className="text-base font-semibold">模型速率排行榜</CardTitle>
          <CardDescription className="text-xs">
            实测净生成速率 (<span className="mono">decode_tps</span>)、首字延迟 TTFT 与样本分布
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={String(days)}
            onValueChange={(v) => {
              onDaysChange(Number(v));
            }}
          >
            <TabsList className="h-8">
              <TabsTrigger value="7" className="text-xs">
                7天
              </TabsTrigger>
              <TabsTrigger value="30" className="text-xs">
                30天
              </TabsTrigger>
              <TabsTrigger value="0" className="text-xs">
                全部
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Tabs
            value={sort}
            onValueChange={(v) => {
              onSortChange(v as LeaderboardSort);
            }}
          >
            <TabsList className="h-8">
              <TabsTrigger value="avg_decode_tps" className="text-xs">
                Avg tok/s
              </TabsTrigger>
              <TabsTrigger value="p50_decode_tps" className="text-xs">
                P50 tok/s
              </TabsTrigger>
              <TabsTrigger value="p90_decode_tps" className="text-xs">
                P90 tok/s
              </TabsTrigger>
              <TabsTrigger value="avg_ttft_ms" className="text-xs">
                最快 TTFT
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>

      <CardContent className="px-5 py-0">
        {items.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            所选时间窗口内暂无测速样本
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item, idx) => {
              const score = metricScore(item, sort);
              const primary = primaryMetric(item, sort);
              const widthPct =
                maxScore > 0 ? Math.max(6, Math.min(100, (score / maxScore) * 100)) : 0;
              const barColor = modelColor(`${item.providerId}/${item.modelId}`);

              return (
                <div
                  key={`${item.providerId}/${item.modelId}`}
                  className="grid grid-cols-[32px_minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5 lg:grid-cols-[32px_minmax(200px,1.4fr)_minmax(120px,1fr)_minmax(140px,1.2fr)_118px_68px]"
                >
                  <Badge
                    variant={idx === 0 ? "default" : "outline"}
                    className="mono size-7 justify-center px-0 text-xs"
                  >
                    #{idx + 1}
                  </Badge>

                  <div className="flex min-w-0 items-center gap-2.5">
                    <LobeIcon slug={item.modelIcon} label={item.modelName} size={20} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{item.modelName}</div>
                      <div className="mono truncate text-[11px] text-muted-foreground">
                        {item.modelId}
                      </div>
                    </div>
                  </div>

                  <div className="hidden min-w-0 items-center gap-2 sm:flex">
                    <LobeIcon slug={item.providerIcon} label={item.providerName} size={16} />
                    <span className="truncate text-xs font-medium">{item.providerName}</span>
                  </div>

                  <div className="hidden lg:block">
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${widthPct.toFixed(1)}%`, backgroundColor: barColor }}
                      />
                    </div>
                  </div>

                  <div className="text-end">
                    <div className="mono text-xs font-semibold">
                      {primary.label} {primary.value} {primary.unit}
                    </div>
                  </div>

                  <div className="text-end">
                    <div className="mono text-xs font-semibold">
                      {formatInteger(item.requestCount)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">样本</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

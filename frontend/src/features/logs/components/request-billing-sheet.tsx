import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  billingError,
  billingStatus,
  getBillingAttempts,
  money,
  type BillingAttempt,
  type BillingAttemptGroup,
} from "../api";

function detailValue(details: Record<string, unknown> | null, key: string): string {
  const value = details?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function tierDetails(details: Record<string, unknown> | null): Record<string, unknown> | null {
  const tier = details?.tier;
  return typeof tier === "object" && tier !== null && !Array.isArray(tier)
    ? (tier as Record<string, unknown>)
    : null;
}

interface ReceiptLineItem {
  label: string;
  category?: string;
  unitPrice?: string;
  quantity?: string;
  amount: string;
}

function receiptItems(details: Record<string, unknown> | null): ReceiptLineItem[] {
  const raw = details?.items;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ReceiptLineItem =>
      typeof item === "object" && item !== null && "label" in item && "amount" in item,
  );
}

function AttemptCard({ item }: { item: BillingAttempt }) {
  const tier = tierDetails(item.details);
  const items = receiptItems(item.details);
  const statusOk = item.statusCode >= 200 && item.statusCode < 400;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 py-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold">
            尝试 #{item.attemptIndex} · {item.providerName} / {item.modelName}
          </CardTitle>
          <Badge variant={statusOk ? "secondary" : "destructive"} className="mono text-[11px]">
            HTTP {item.statusCode}
          </Badge>
        </div>
        <CardDescription className="mono text-xs">
          {item.amount === null
            ? billingStatus(item.billingStatus)
            : `${item.billingStatus === "estimated" ? "估算 " : ""}${money(item.amount, item.currency)}`}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 px-4 py-0 text-xs">
        {item.billingStatus === "estimated" && item.details?.source ? (
          <p className="text-muted-foreground">估算依据：{detailValue(item.details, "source")}</p>
        ) : null}

        {item.details?.error ? (
          <Alert variant="destructive" className="py-2">
            <AlertDescription className="mono text-xs">
              {detailValue(item.details, "error")}
            </AlertDescription>
          </Alert>
        ) : null}

        {items.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((line, idx) => (
              <div key={`${line.label}-${idx}`} className="rounded-md border bg-muted/30 p-2.5">
                <div className="font-medium">{line.label}</div>
                <div className="mono mt-1 text-muted-foreground">{line.quantity ?? "—"}</div>
                <div className="text-muted-foreground">
                  {line.unitPrice ? `单价：${line.unitPrice}` : (line.category ?? "—")}
                </div>
                <div className="mono mt-1 font-semibold">{money(line.amount, item.currency)}</div>
              </div>
            ))}
          </div>
        ) : null}

        {items.length === 0 && tier ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              价格分档：{detailValue(tier, "minInputTokens")} Token 起 · 单位 {item.currency} / 百万
              Token
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["普通输入", "inputTokens", "inputAmount", "inputPrice"],
                  ["输出", "outputTokens", "outputAmount", "outputPrice"],
                  ["缓存读取", "cacheReadTokens", "cacheReadAmount", "cacheReadPrice"],
                  ["缓存写入", "cacheWriteTokens", "cacheWriteAmount", "cacheWritePrice"],
                ] as const
              ).map(([label, tokens, amount, price]) => {
                const resolvedPrice =
                  detailValue(tier, price) === "—" &&
                  (price === "cacheReadPrice" ||
                    (price === "cacheWritePrice" && tier.cacheWriteMode === "input"))
                    ? detailValue(tier, "inputPrice")
                    : detailValue(tier, price);
                const rawAmount = detailValue(item.details, amount);
                return (
                  <div key={label} className="rounded-md border bg-muted/30 p-2.5">
                    <div className="font-medium">{label}</div>
                    <div className="mono text-muted-foreground">
                      {detailValue(item.details, tokens)} Token
                    </div>
                    <div className="text-muted-foreground">单价：{resolvedPrice}</div>
                    <div className="mono mt-0.5 font-semibold">
                      {money(rawAmount === "—" ? null : rawAmount, item.currency)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface RequestBillingSheetProps {
  requestUid: string | null;
  onClose: () => void;
}

export function RequestBillingSheet({ requestUid, onClose }: RequestBillingSheetProps) {
  const [result, setResult] = useState<{
    uid: string;
    page: number;
    group: BillingAttemptGroup;
  } | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    setError("");
  }, [requestUid]);

  useEffect(() => {
    if (!requestUid) return;
    const controller = new AbortController();
    void getBillingAttempts(requestUid, page, controller.signal)
      .then((value) => {
        setResult({ uid: requestUid, page, group: value });
        setError("");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(billingError(reason));
        }
      });
    return () => {
      controller.abort();
    };
  }, [requestUid, page]);

  const group =
    requestUid && result?.uid === requestUid && result.page === page ? result.group : null;

  return (
    <Sheet
      open={Boolean(requestUid)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader className="border-b pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="size-4 text-primary" />
            请求计价明细
          </SheetTitle>
          <SheetDescription className="mono text-xs break-all">
            {requestUid ?? ""}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 py-4">
          <div className="space-y-4">
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>加载失败</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {!group && !error ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : null}

            {group ? (
              <>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                  <span className="text-muted-foreground">已计价汇总：</span>
                  <span className="mono font-semibold">
                    {group.totals.length
                      ? group.totals.map((total) => money(total.amount, total.currency)).join(" · ")
                      : "—"}
                  </span>
                  <Badge variant="outline" className="ms-auto text-xs">
                    未计价 {group.unpriced}
                  </Badge>
                </div>

                <div className="space-y-3">
                  {group.items.map((attempt) => (
                    <AttemptCard
                      key={`${attempt.requestUid}-${attempt.attemptIndex}`}
                      item={attempt}
                    />
                  ))}
                </div>

                {page > 1 || group.hasNext ? (
                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1}
                      onClick={() => {
                        setPage(page - 1);
                      }}
                    >
                      <ChevronLeft className="size-4" />
                      上一页
                    </Button>
                    <span className="text-xs text-muted-foreground">第 {page} 页</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!group.hasNext}
                      onClick={() => {
                        setPage(page + 1);
                      }}
                    >
                      下一页
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

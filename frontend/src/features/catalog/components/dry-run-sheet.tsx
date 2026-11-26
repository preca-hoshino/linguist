import { useState, type SubmitEvent } from "react";
import { Check, Copy, Play } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/context/auth-provider";
import { useSearch } from "@/context/search-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { CatalogError, catalogErrorMessage, dryRunCatalog } from "../api";
import type { DryRunResult } from "../types";

export function DryRunSheet() {
  const { dryRunOpen, setDryRunOpen } = useSearch();
  const { csrfToken, handleUnauthorized } = useAuth();
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [stream, setStream] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setErrorMsg("");
    setResult(null);
    try {
      const res = await dryRunCatalog(
        { projectId: projectId.trim(), model: model.trim(), stream },
        csrfToken,
      );
      setResult(res);
    } catch (err) {
      if (err instanceof CatalogError && err.status === 401) {
        handleUnauthorized();
        return;
      }
      setErrorMsg(catalogErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function handleCopyJson() {
    if (!result) return;
    void navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    toast.success("已复制 Dry-Run 结果 JSON");
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  return (
    <Sheet open={dryRunOpen} onOpenChange={setDryRunOpen}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader className="border-b pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Play className="size-4 text-primary" />
            Dry-Run 路由与脚本演练
          </SheetTitle>
          <SheetDescription>
            模拟执行 5 阶段路由与请求改编脚本流水线，不会实际发起上游请求。
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="space-y-4 border-b px-4 py-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dryrun-project">Project ID</Label>
              <Input
                id="dryrun-project"
                className="mono"
                placeholder="例如 default"
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                }}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dryrun-model">Model</Label>
              <Input
                id="dryrun-model"
                className="mono"
                placeholder="例如 deepseek-v4-pro"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
                required
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="dryrun-stream" className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch id="dryrun-stream" checked={stream} onCheckedChange={setStream} />
              <span>模拟流式请求 (stream: true)</span>
            </label>
            <Button type="submit" disabled={loading} className="gap-1.5">
              <Play className="size-3.5" />
              {loading ? "演练中…" : "运行演练"}
            </Button>
          </div>
        </form>

        <div className="flex flex-1 flex-col overflow-hidden px-4 py-4">
          {errorMsg ? (
            <Alert variant="destructive">
              <AlertTitle>演练失败</AlertTitle>
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          ) : null}

          {result ? (
            <div className="flex flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={result.status === "ready" ? "default" : "destructive"}>
                    {result.status}
                  </Badge>
                  {result.routeRuleId ? (
                    <span className="mono text-xs text-muted-foreground">
                      rule: {result.routeRuleId}
                    </span>
                  ) : null}
                </div>
                <Button variant="outline" size="sm" onClick={handleCopyJson} className="gap-1.5">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "已复制" : "复制 JSON"}
                </Button>
              </div>

              <ScrollArea className="flex-1 rounded-md border bg-muted/40 p-3">
                <pre className="mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </ScrollArea>
            </div>
          ) : !errorMsg ? (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              填写 Project ID 与 Model 后点击运行演练
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

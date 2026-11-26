import { useState, type ReactNode } from "react";
import { HelpCircle, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ChartCardProps {
  title: string;
  description?: string;
  helpText?: string;
  controls?: ReactNode;
  empty?: boolean;
  emptyText?: string;
  loading?: boolean;
  fullWidth?: boolean;
  span?: 1 | 2 | 3;
  expandable?: boolean;
  children: ReactNode;
}

export function ChartCard({
  title,
  description,
  helpText,
  controls,
  empty = false,
  emptyText = "当前筛选条件下暂无数据",
  loading = false,
  fullWidth = false,
  span,
  expandable = true,
  children,
}: ChartCardProps) {
  const [expanded, setExpanded] = useState(false);

  const spanClass =
    fullWidth || span === 3
      ? "col-span-full"
      : span === 2
        ? "md:col-span-2"
        : "";

  const tip = helpText ?? description;

  return (
    <>
      <Card className={cn("min-w-0 gap-4 py-5", spanClass)}>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 px-5 py-0">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-sm font-semibold">{title}</CardTitle>
              {tip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={tip}
                    >
                      <HelpCircle className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{tip}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            {description ? (
              <CardDescription className="text-xs">{description}</CardDescription>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {controls}
            {expandable && !loading && !empty ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                title="放大查看"
                aria-label={`放大查看 ${title}`}
                onClick={() => {
                  setExpanded(true);
                }}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="px-5 py-0">
          {loading ? (
            <Skeleton className="h-[210px] w-full rounded-lg" />
          ) : empty ? (
            <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {emptyText}
            </div>
          ) : (
            children
          )}
        </CardContent>
      </Card>

      {expanded ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="max-h-[90vh] w-[92vw] max-w-[92vw] overflow-y-auto sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {tip ? <DialogDescription>{tip}</DialogDescription> : null}
            </DialogHeader>
            <div className="pt-2">{children}</div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

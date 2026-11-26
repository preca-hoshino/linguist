import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type StatTone = "default" | "green" | "blue" | "amber" | "red";

const TONE_CLASS: Record<StatTone, string> = {
  default: "text-foreground",
  green: "text-emerald-600 dark:text-emerald-400",
  blue: "text-blue-600 dark:text-blue-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

interface StatKpiCardProps {
  title: string;
  value: string;
  subValue?: string;
  helpText?: string;
  tone?: StatTone;
  compact?: boolean;
}

export function StatKpiCard({
  title,
  value,
  subValue,
  helpText,
  tone = "default",
  compact = false,
}: StatKpiCardProps) {
  return (
    <Card className={cn("gap-2", compact ? "py-3.5" : "py-4")}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-0">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        {helpText ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={helpText}
              >
                <HelpCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{helpText}</TooltipContent>
          </Tooltip>
        ) : null}
      </CardHeader>
      <CardContent className="px-4 py-0">
        <div className={cn("mono text-2xl font-bold tracking-tight", TONE_CLASS[tone])}>
          {value}
        </div>
        {subValue ? (
          <p className="mono mt-1 truncate text-xs text-muted-foreground" title={subValue}>
            {subValue}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

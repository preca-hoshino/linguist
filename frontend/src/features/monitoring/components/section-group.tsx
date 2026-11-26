import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface SectionGroupProps {
  title: string;
  subtitle?: string;
  controls?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function SectionGroup({
  title,
  subtitle,
  controls,
  defaultOpen = true,
  children,
}: SectionGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-1 py-0.5 text-start hover:bg-muted/50"
          >
            {open ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
            <span className="text-sm font-semibold tracking-tight">{title}</span>
            {subtitle ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">{subtitle}</span>
            ) : null}
          </button>
        </CollapsibleTrigger>
        {open && controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
      </div>
      <CollapsibleContent className="CollapsibleContent">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

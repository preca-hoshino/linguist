import { Search as SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSearch } from "@/context/search-provider";
import { Button } from "@/components/ui/button";

interface SearchProps {
  className?: string;
  placeholder?: string;
}

export function Search({ className = "", placeholder = "搜索页面或命令…" }: SearchProps) {
  const { setOpen } = useSearch();

  return (
    <Button
      variant="outline"
      className={cn(
        "group relative h-8 w-full flex-1 justify-start rounded-md bg-muted/25 text-sm font-normal text-muted-foreground shadow-none hover:bg-accent sm:w-44 sm:pe-12 md:flex-none lg:w-60",
        className,
      )}
      onClick={() => {
        setOpen(true);
      }}
    >
      <SearchIcon aria-hidden="true" className="absolute start-2.5 top-1/2 -translate-y-1/2 size-3.5" />
      <span className="ms-5 truncate">{placeholder}</span>
      <kbd className="pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium select-none group-hover:bg-accent sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </Button>
  );
}

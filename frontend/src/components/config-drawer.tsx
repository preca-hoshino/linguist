import { RotateCcw, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayout, type Collapsible, type Variant } from "@/context/layout-provider";
import { useTheme, type Theme } from "@/context/theme-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";

export function ConfigDrawer() {
  const { setOpen } = useSidebar();
  const { resetTheme, theme, setTheme } = useTheme();
  const { resetLayout, variant, setVariant, collapsible, setCollapsible } = useLayout();

  const handleReset = () => {
    setOpen(true);
    resetTheme();
    resetLayout();
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label="打开主题与布局设置"
          className="rounded-full"
        >
          <Settings2 aria-hidden="true" className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col">
        <SheetHeader className="border-b pb-3 text-start">
          <SheetTitle>界面配置</SheetTitle>
          <SheetDescription>快速调整全局主题色板、侧边栏样式与折叠方式。</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
          <div className="space-y-2.5">
            <Label className="text-xs font-semibold text-muted-foreground">主题模式</Label>
            <RadioGroup
              value={theme}
              onValueChange={(v) => {
                setTheme(v as Theme);
              }}
              className="grid grid-cols-3 gap-2"
            >
              {(
                [
                  ["system", "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-xs font-medium transition-colors",
                    theme === value
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <RadioGroupItem value={value} className="sr-only" />
                  {label}
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2.5 max-md:hidden">
            <Label className="text-xs font-semibold text-muted-foreground">侧边栏样式</Label>
            <RadioGroup
              value={variant}
              onValueChange={(v) => {
                setVariant(v as Variant);
              }}
              className="grid grid-cols-3 gap-2"
            >
              {(
                [
                  ["inset", "内嵌 Inset"],
                  ["floating", "悬浮 Float"],
                  ["sidebar", "标准平铺"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-xs font-medium transition-colors",
                    variant === value
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <RadioGroupItem value={value} className="sr-only" />
                  {label}
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2.5 max-md:hidden">
            <Label className="text-xs font-semibold text-muted-foreground">折叠模式</Label>
            <RadioGroup
              value={collapsible}
              onValueChange={(v) => {
                setCollapsible(v as Collapsible);
              }}
              className="grid grid-cols-3 gap-2"
            >
              {(
                [
                  ["icon", "图标栏"],
                  ["offcanvas", "完全收起"],
                  ["none", "固定展开"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-xs font-medium transition-colors",
                    collapsible === value
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  <RadioGroupItem value={value} className="sr-only" />
                  {label}
                </label>
              ))}
            </RadioGroup>
          </div>
        </div>
        <SheetFooter className="border-t pt-3">
          <Button variant="outline" className="w-full gap-2" onClick={handleReset}>
            <RotateCcw className="size-3.5" />
            恢复默认布局
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

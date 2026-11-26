import { toast } from "sonner";
import { useLayout, type Variant } from "@/context/layout-provider";
import { usePreferences, type TableDensity } from "@/context/preferences-provider";
import { useTheme, type Theme } from "@/context/theme-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ContentSection } from "../components/content-section";

export function AppearanceSettings() {
  const { theme, setTheme, resetTheme } = useTheme();
  const { variant, setVariant, resetLayout } = useLayout();
  const { preferences, updatePreferences } = usePreferences();

  return (
    <ContentSection title="外观与主题" desc="定制控制台的浅色/深色主题、侧边栏形态与表格密度。">
      <div className="space-y-8">
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium">颜色主题</Label>
            <p className="text-xs text-muted-foreground">
              同步应用于控制台卡片、Recharts 图表配色与 Monaco 脚本编辑器。
            </p>
          </div>
          <RadioGroup
            value={theme}
            onValueChange={(val) => {
              setTheme(val as Theme);
              toast.success("已切换主题模式");
            }}
            className="grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-3"
          >
            <label className="cursor-pointer space-y-2 [&:has([data-state=checked])>div]:border-primary">
              <RadioGroupItem value="light" className="sr-only" />
              <div className="rounded-md border-2 border-muted p-1 transition-colors hover:border-accent-foreground/30">
                <div className="space-y-2 rounded-sm bg-[#ecedef] p-2">
                  <div className="space-y-1.5 rounded-md bg-white p-2 shadow-xs">
                    <div className="h-2 w-16 rounded-lg bg-[#ecedef]" />
                    <div className="h-2 w-24 rounded-lg bg-[#ecedef]" />
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-white p-2 shadow-xs">
                    <div className="size-3.5 rounded-full bg-[#ecedef]" />
                    <div className="h-2 w-20 rounded-lg bg-[#ecedef]" />
                  </div>
                </div>
              </div>
              <span className="block text-center text-xs font-medium">浅色 (Light)</span>
            </label>

            <label className="cursor-pointer space-y-2 [&:has([data-state=checked])>div]:border-primary">
              <RadioGroupItem value="dark" className="sr-only" />
              <div className="rounded-md border-2 border-muted bg-popover p-1 transition-colors hover:border-accent-foreground/30">
                <div className="space-y-2 rounded-sm bg-slate-950 p-2">
                  <div className="space-y-1.5 rounded-md bg-slate-800 p-2 shadow-xs">
                    <div className="h-2 w-16 rounded-lg bg-slate-500" />
                    <div className="h-2 w-24 rounded-lg bg-slate-500" />
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-slate-800 p-2 shadow-xs">
                    <div className="size-3.5 rounded-full bg-slate-500" />
                    <div className="h-2 w-20 rounded-lg bg-slate-500" />
                  </div>
                </div>
              </div>
              <span className="block text-center text-xs font-medium">深色 (Dark)</span>
            </label>

            <label className="cursor-pointer space-y-2 [&:has([data-state=checked])>div]:border-primary">
              <RadioGroupItem value="system" className="sr-only" />
              <div className="rounded-md border-2 border-muted p-1 transition-colors hover:border-accent-foreground/30">
                <div className="grid grid-cols-2 gap-1 rounded-sm bg-muted p-2">
                  <div className="space-y-1.5 rounded-md bg-white p-2 shadow-xs">
                    <div className="h-2 w-10 rounded-lg bg-[#ecedef]" />
                    <div className="h-2 w-12 rounded-lg bg-[#ecedef]" />
                    <div className="h-2 w-8 rounded-lg bg-[#ecedef]" />
                  </div>
                  <div className="space-y-1.5 rounded-md bg-slate-900 p-2 shadow-xs">
                    <div className="h-2 w-10 rounded-lg bg-slate-600" />
                    <div className="h-2 w-12 rounded-lg bg-slate-600" />
                    <div className="h-2 w-8 rounded-lg bg-slate-600" />
                  </div>
                </div>
              </div>
              <span className="block text-center text-xs font-medium">跟随系统 (System)</span>
            </label>
          </RadioGroup>
        </div>

        <div className="space-y-3 max-md:hidden">
          <div>
            <Label className="text-sm font-medium">侧边栏容器风格</Label>
            <p className="text-xs text-muted-foreground">
              默认使用带圆角主卡片的 Inset 风格，也可切换为悬浮或全高侧边栏。
            </p>
          </div>
          <RadioGroup
            value={variant}
            onValueChange={(val) => {
              setVariant(val as Variant);
              toast.success("已更新侧边栏风格");
            }}
            className="grid max-w-md grid-cols-3 gap-3"
          >
            {(
              [
                ["inset", "内嵌 Inset"],
                ["floating", "悬浮 Floating"],
                ["sidebar", "标准 Sidebar"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm font-medium transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
              >
                <RadioGroupItem value={value} />
                <span>{label}</span>
              </label>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium">列表与数据表密度</Label>
            <p className="text-xs text-muted-foreground">
              紧凑模式可在请求日志和目录配置页同屏展示更多记录。
            </p>
          </div>
          <RadioGroup
            value={preferences.tableDensity}
            onValueChange={(val) => {
              updatePreferences({ tableDensity: val as TableDensity });
              toast.success("已更新表格显示密度");
            }}
            className="grid max-w-sm grid-cols-2 gap-3"
          >
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm font-medium has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="comfortable" />
              <span>标准间距</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm font-medium has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="compact" />
              <span>紧凑高密度</span>
            </label>
          </RadioGroup>
        </div>

        <div className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              resetTheme();
              resetLayout();
              updatePreferences({ tableDensity: "comfortable" });
              toast.success("已恢复默认外观设置");
            }}
          >
            恢复默认外观
          </Button>
        </div>
      </div>
    </ContentSection>
  );
}

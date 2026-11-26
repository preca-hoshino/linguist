import { toast } from "sonner";
import {
  usePreferences,
  type LogsPageSize,
  type PollingIntervalMs,
} from "@/context/preferences-provider";
import type { TimeRangeKey } from "@/features/monitoring/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ContentSection } from "../components/content-section";

export function PreferencesSettings() {
  const { preferences, updatePreferences, resetPreferences } = usePreferences();

  return (
    <ContentSection
      title="控制台偏好"
      desc="配置实时监控轮询间隔、默认列表分页及 Monaco 脚本编辑器行为（保存于浏览器本地）。"
    >
      <div className="space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="pref-polling">自动轮询间隔</Label>
          <Select
            value={String(preferences.pollingIntervalMs)}
            onValueChange={(val) => {
              updatePreferences({ pollingIntervalMs: Number(val) as PollingIntervalMs });
              toast.success("已更新自动轮询间隔");
            }}
          >
            <SelectTrigger id="pref-polling" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">关闭自动轮询</SelectItem>
              <SelectItem value="5000">每 5 秒刷新（实时）</SelectItem>
              <SelectItem value="15000">每 15 秒刷新</SelectItem>
              <SelectItem value="30000">每 30 秒刷新</SelectItem>
              <SelectItem value="60000">每 60 秒刷新</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            作用于统计总览、多维监控与请求日志页的后台自动刷新策略。
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="pref-range">多维监控默认时间窗口</Label>
          <Select
            value={preferences.defaultMonitoringRange}
            onValueChange={(val) => {
              updatePreferences({ defaultMonitoringRange: val as TimeRangeKey });
              toast.success("已更新默认监控窗口");
            }}
          >
            <SelectTrigger id="pref-range" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">近 1 小时</SelectItem>
              <SelectItem value="6h">近 6 小时</SelectItem>
              <SelectItem value="24h">近 24 小时</SelectItem>
              <SelectItem value="7d">近 7 天</SelectItem>
              <SelectItem value="30d">近 30 天</SelectItem>
              <SelectItem value="90d">近 90 天</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="pref-pagesize">请求日志默认每页条数</Label>
          <Select
            value={String(preferences.defaultLogsPageSize)}
            onValueChange={(val) => {
              updatePreferences({ defaultLogsPageSize: Number(val) as LogsPageSize });
              toast.success("已更新日志默认分页大小");
            }}
          >
            <SelectTrigger id="pref-pagesize" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">20 条 / 页</SelectItem>
              <SelectItem value="50">50 条 / 页</SelectItem>
              <SelectItem value="100">100 条 / 页</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-4 rounded-lg border p-4">
          <h4 className="text-sm font-medium">Monaco 脚本编辑器偏好</h4>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pref-fontsize">代码字号</Label>
              <p className="text-xs text-muted-foreground">调整脚本编辑器文字大小（px）</p>
            </div>
            <Select
              value={String(preferences.editorFontSize)}
              onValueChange={(val) => {
                updatePreferences({ editorFontSize: Number(val) });
              }}
            >
              <SelectTrigger id="pref-fontsize" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[12, 13, 14, 15, 16].map((sz) => (
                  <SelectItem key={sz} value={String(sz)}>
                    {sz} px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pref-wordwrap">自动折行 (Word Wrap)</Label>
              <p className="text-xs text-muted-foreground">长 URL 或内联 JSON 文本自动换行显示</p>
            </div>
            <Switch
              id="pref-wordwrap"
              checked={preferences.editorWordWrap}
              onCheckedChange={(checked) => {
                updatePreferences({ editorWordWrap: checked });
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pref-minimap">显示代码缩略图 (Minimap)</Label>
              <p className="text-xs text-muted-foreground">在右侧显示脚本代码全局定位缩略图</p>
            </div>
            <Switch
              id="pref-minimap"
              checked={preferences.editorMinimap}
              onCheckedChange={(checked) => {
                updatePreferences({ editorMinimap: checked });
              }}
            />
          </div>
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              resetPreferences();
              toast.success("已重置控制台偏好设置");
            }}
          >
            恢复默认偏好
          </Button>
        </div>
      </div>
    </ContentSection>
  );
}

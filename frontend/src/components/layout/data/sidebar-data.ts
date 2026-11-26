import {
  Activity,
  Bot,
  Boxes,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  Palette,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { NavGroupData } from "../types";

export const sidebarData: { navGroups: NavGroupData[] } = {
  navGroups: [
    {
      title: "观测分析",
      items: [
        {
          title: "统计总览",
          url: "/",
          icon: LayoutDashboard,
        },
        {
          title: "多维监控",
          icon: Activity,
          items: [
            { title: "用量", url: "/data?tab=usage" },
            { title: "性能", url: "/data?tab=performance" },
            { title: "路由", url: "/data?tab=routing" },
            { title: "异常", url: "/data?tab=errors" },
            { title: "成本", url: "/data?tab=cost" },
            { title: "运行时", url: "/data?tab=runtime" },
          ],
        },
        {
          title: "请求日志",
          url: "/logs",
          icon: ScrollText,
        },
      ],
    },
    {
      title: "供给侧",
      items: [
        {
          title: "提供商",
          url: "/providers",
          icon: Server,
        },
        {
          title: "提供商模型",
          url: "/provider-models",
          icon: Bot,
        },
      ],
    },
    {
      title: "调用侧",
      items: [
        {
          title: "项目",
          url: "/projects",
          icon: FolderKanban,
        },
        {
          title: "项目调用模型",
          url: "/project-models",
          icon: Boxes,
        },
      ],
    },
    {
      title: "编排与系统",
      items: [
        {
          title: "路由规则",
          url: "/routes",
          icon: GitBranch,
        },
        {
          title: "系统设置",
          icon: Settings,
          items: [
            { title: "外观与主题", url: "/settings", icon: Palette },
            { title: "控制台偏好", url: "/settings/preferences", icon: SlidersHorizontal },
            { title: "账户与会话", url: "/settings/account", icon: ShieldCheck },
            { title: "系统状态", url: "/settings/system", icon: ServerCog },
          ],
        },
      ],
    },
  ],
};

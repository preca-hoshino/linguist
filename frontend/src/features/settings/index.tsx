import { Outlet } from "react-router";
import { Palette, ServerCog, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ConfigDrawer } from "@/components/config-drawer";
import { Header } from "@/components/layout/header";
import { Main } from "@/components/layout/main";
import { ProfileDropdown } from "@/components/profile-dropdown";
import { Search } from "@/components/search";
import { ThemeSwitch } from "@/components/theme-switch";
import { SidebarNav } from "./components/sidebar-nav";

const sidebarNavItems = [
  {
    title: "外观与主题",
    href: "/settings",
    icon: <Palette className="size-4" />,
  },
  {
    title: "控制台偏好",
    href: "/settings/preferences",
    icon: <SlidersHorizontal className="size-4" />,
  },
  {
    title: "账户与会话",
    href: "/settings/account",
    icon: <ShieldCheck className="size-4" />,
  },
  {
    title: "系统状态",
    href: "/settings/system",
    icon: <ServerCog className="size-4" />,
  },
];

export function SettingsPage() {
  return (
    <>
      <Header fixed>
        <Search className="me-auto" />
        <div className="flex items-center gap-2">
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main fixed>
        <div className="space-y-0.5">
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">系统设置</h1>
          <p className="text-sm text-muted-foreground">
            管理控制台外观主题、监控轮询偏好、管理员会话与网关只读运行状态。
          </p>
        </div>
        <Separator className="my-4 lg:my-6" />
        <div className="flex flex-1 flex-col space-y-4 overflow-hidden lg:flex-row lg:space-y-0 lg:space-x-10">
          <aside className="top-0 lg:sticky lg:w-1/5">
            <SidebarNav items={sidebarNavItems} />
          </aside>
          <div className="flex w-full overflow-y-hidden p-1">
            <Outlet />
          </div>
        </div>
      </Main>
    </>
  );
}

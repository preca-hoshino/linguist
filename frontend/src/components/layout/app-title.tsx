import { Link } from "react-router";
import { LinguistLogo } from "@/assets/logo";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppTitle() {
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className="gap-2.5 py-1 hover:bg-transparent active:bg-transparent"
          asChild
        >
          <Link
            to="/"
            onClick={() => {
              setOpenMobile(false);
            }}
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <LinguistLogo className="size-4" />
            </div>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-semibold tracking-tight">Linguist</span>
              <span className="truncate text-xs text-muted-foreground">AI Gateway Console</span>
            </div>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

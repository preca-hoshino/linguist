import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NavCollapsible, NavGroupData, NavItem, NavLink } from "./types";

function checkIsActive(pathname: string, search: string, item: NavItem, mainNav = false): boolean {
  const fullHref = `${pathname}${search}`;

  if (item.url !== undefined) {
    const [targetPath, targetQuery] = item.url.split("?");
    if (targetQuery) {
      if (pathname !== targetPath) return false;
      const currentParams = new URLSearchParams(search);
      const expectedParams = new URLSearchParams(targetQuery);
      for (const [k, v] of expectedParams.entries()) {
        if (currentParams.get(k) !== v) return false;
      }
      return true;
    }
    if (item.url === "/") return pathname === "/";
    return pathname === targetPath || fullHref === item.url;
  }

  const subItems = item.items;
  if (subItems.some((sub) => checkIsActive(pathname, search, sub))) {
    return true;
  }

  if (mainNav) {
    const first = subItems[0];
    if (first) {
      const firstRoot = first.url.split("?")[0]?.split("/")[1];
      const currentRoot = pathname.split("/")[1];
      return Boolean(firstRoot && currentRoot === firstRoot);
    }
  }

  return false;
}

function NavBadge({ children }: { children: ReactNode }) {
  return <Badge className="rounded-full px-1.5 py-0 text-[10px]">{children}</Badge>;
}

function SidebarMenuLink({
  item,
  pathname,
  search,
}: {
  item: NavLink;
  pathname: string;
  search: string;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={checkIsActive(pathname, search, item)}
        tooltip={item.title}
      >
        <Link
          to={item.url}
          onClick={() => {
            setOpenMobile(false);
          }}
        >
          {item.icon ? <item.icon /> : null}
          <span>{item.title}</span>
          {item.badge ? <NavBadge>{item.badge}</NavBadge> : null}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarMenuCollapsible({
  item,
  pathname,
  search,
}: {
  item: NavCollapsible;
  pathname: string;
  search: string;
}) {
  const { setOpenMobile } = useSidebar();
  const isChildActive = checkIsActive(pathname, search, item, true);

  return (
    <Collapsible asChild defaultOpen={isChildActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={isChildActive}>
            {item.icon ? <item.icon /> : null}
            <span>{item.title}</span>
            {item.badge ? <NavBadge>{item.badge}</NavBadge> : null}
            <ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="CollapsibleContent">
          <SidebarMenuSub>
            {item.items.map((subItem) => (
              <SidebarMenuSubItem key={subItem.url}>
                <SidebarMenuSubButton
                  asChild
                  isActive={checkIsActive(pathname, search, subItem)}
                >
                  <Link
                    to={subItem.url}
                    onClick={() => {
                      setOpenMobile(false);
                    }}
                  >
                    {subItem.icon ? <subItem.icon /> : null}
                    <span>{subItem.title}</span>
                    {subItem.badge ? <NavBadge>{subItem.badge}</NavBadge> : null}
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function SidebarMenuCollapsedDropdown({
  item,
  pathname,
  search,
}: {
  item: NavCollapsible;
  pathname: string;
  search: string;
}) {
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={item.title}
            isActive={checkIsActive(pathname, search, item, true)}
          >
            {item.icon ? <item.icon /> : null}
            <span>{item.title}</span>
            {item.badge ? <NavBadge>{item.badge}</NavBadge> : null}
            <ChevronRight className="ms-auto" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={4}>
          <DropdownMenuLabel>
            {item.title} {item.badge ? `(${item.badge})` : ""}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {item.items.map((sub) => (
            <DropdownMenuItem key={sub.url} asChild>
              <Link
                to={sub.url}
                className={checkIsActive(pathname, search, sub) ? "bg-secondary" : ""}
              >
                {sub.icon ? <sub.icon /> : null}
                <span className="max-w-52 text-wrap">{sub.title}</span>
                {sub.badge ? <span className="ms-auto text-xs">{sub.badge}</span> : null}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

export function NavGroup({ title, items }: NavGroupData) {
  const { state, isMobile } = useSidebar();
  const { pathname, search } = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{title}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const key = item.url ?? item.title;
          if (!item.items) {
            return <SidebarMenuLink key={key} item={item} pathname={pathname} search={search} />;
          }
          if (state === "collapsed" && !isMobile) {
            return (
              <SidebarMenuCollapsedDropdown
                key={key}
                item={item}
                pathname={pathname}
                search={search}
              />
            );
          }
          return (
            <SidebarMenuCollapsible key={key} item={item} pathname={pathname} search={search} />
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

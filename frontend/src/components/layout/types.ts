import type { LucideIcon } from "lucide-react";

interface BaseNavItem {
  title: string;
  badge?: string;
  icon?: LucideIcon;
}

export type NavLink = BaseNavItem & {
  url: string;
  items?: never;
};

export type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: string })[];
  url?: never;
};

export type NavItem = NavLink | NavCollapsible;

export interface NavGroupData {
  title: string;
  items: NavItem[];
}

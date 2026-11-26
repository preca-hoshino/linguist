import type { JSX } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
  items: {
    href: string;
    title: string;
    icon: JSX.Element;
  }[];
}

export function SidebarNav({ className, items, ...props }: SidebarNavProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeHref = items.some((item) => item.href === pathname) ? pathname : "/settings";

  const handleSelect = (nextHref: string) => {
    void navigate(nextHref);
  };

  return (
    <>
      <div className="p-1 md:hidden">
        <Select value={activeHref} onValueChange={handleSelect}>
          <SelectTrigger className="h-10 w-full">
            <SelectValue placeholder="选择设置项" />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.href} value={item.href}>
                <div className="flex items-center gap-2.5 py-0.5">
                  <span>{item.icon}</span>
                  <span>{item.title}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ScrollArea type="always" className="hidden w-full min-w-44 bg-background px-1 py-1 md:block">
        <nav
          aria-label="设置导航"
          className={cn("flex space-x-2 lg:flex-col lg:space-y-1 lg:space-x-0", className)}
          {...props}
        >
          {items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  active
                    ? "bg-muted hover:bg-accent font-medium"
                    : "hover:bg-accent/60 hover:underline",
                  "justify-start gap-2.5",
                )}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.title}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>
    </>
  );
}

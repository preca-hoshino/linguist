import { useCallback } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Laptop, Moon, Play, Sun } from "lucide-react";
import { useSearch } from "@/context/search-provider";
import { useTheme } from "@/context/theme-provider";
import { sidebarData } from "@/components/layout/data/sidebar-data";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export function CommandMenu() {
  const navigate = useNavigate();
  const { setTheme } = useTheme();
  const { open, setOpen, setDryRunOpen } = useSearch();

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      command();
    },
    [setOpen],
  );

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen} title="全局导航" description="快速跳转页面、演练路由或切换主题">
      <CommandInput placeholder="输入页面名称、命令或关键字…" />
      <CommandList className="max-h-80">
        <CommandEmpty>未找到匹配项</CommandEmpty>
        <CommandGroup heading="快捷工具">
          <CommandItem
            onSelect={() => {
              runCommand(() => {
                setDryRunOpen(true);
              });
            }}
          >
            <Play className="size-4 text-muted-foreground" />
            <span>Dry-Run 路由与脚本演练</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {sidebarData.navGroups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.items.map((navItem) => {
              if (!navItem.items) {
                return (
                  <CommandItem
                    key={navItem.url}
                    value={`${group.title} ${navItem.title} ${navItem.url}`}
                    onSelect={() => {
                      runCommand(() => {
                        void navigate(navItem.url);
                      });
                    }}
                  >
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <span>{navItem.title}</span>
                  </CommandItem>
                );
              }
              return navItem.items.map((subItem) => (
                <CommandItem
                  key={subItem.url}
                  value={`${navItem.title} ${subItem.title} ${subItem.url}`}
                  onSelect={() => {
                    runCommand(() => {
                      void navigate(subItem.url);
                    });
                  }}
                >
                  <ArrowRight className="size-3.5 text-muted-foreground" />
                  <span>
                    {navItem.title} / {subItem.title}
                  </span>
                </CommandItem>
              ));
            })}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="主题切换">
          <CommandItem
            onSelect={() => {
              runCommand(() => {
                setTheme("light");
              });
            }}
          >
            <Sun className="size-4" />
            <span>浅色模式</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              runCommand(() => {
                setTheme("dark");
              });
            }}
          >
            <Moon className="size-4" />
            <span>深色模式</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              runCommand(() => {
                setTheme("system");
              });
            }}
          >
            <Laptop className="size-4" />
            <span>跟随系统</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

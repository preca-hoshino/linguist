import { Link } from "react-router";
import { LogOut, Palette, Settings, ShieldCheck, SlidersHorizontal } from "lucide-react";
import useDialogState from "@/hooks/use-dialog-state";
import { useAuth } from "@/context/auth-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SignOutDialog } from "@/components/sign-out-dialog";

function userInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "LG";
  return trimmed.slice(0, 2).toUpperCase();
}

export function ProfileDropdown() {
  const [open, setOpen] = useDialogState<boolean>(false);
  const { user } = useAuth();
  const displayName = user?.displayName || user?.subject || "管理员";
  const subtitle = user?.email || user?.subject || "OIDC Admin";

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="relative h-8 w-8 rounded-full">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs font-semibold">
                {userInitials(displayName)}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-1">
              <p className="truncate text-sm leading-none font-medium">{displayName}</p>
              <p className="truncate text-xs leading-none text-muted-foreground">{subtitle}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <Palette />
                外观与主题
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/settings/preferences">
                <SlidersHorizontal />
                控制台偏好
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/settings/account">
                <ShieldCheck />
                账户与会话
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/settings/system">
                <Settings />
                系统状态
              </Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              setOpen(true);
            }}
          >
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={Boolean(open)} onOpenChange={(val) => { setOpen(val); }} />
    </>
  );
}

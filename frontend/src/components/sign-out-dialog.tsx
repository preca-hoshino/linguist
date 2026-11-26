import { useState } from "react";
import { useAuth } from "@/context/auth-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface SignOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const { logout } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleSignOut = () => {
    setLoading(true);
    void logout().finally(() => {
      setLoading(false);
      onOpenChange(false);
    });
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="退出登录"
      desc="确认退出当前管理员会话吗？退出后需要重新通过统一身份认证登录控制台。"
      confirmText="确认退出"
      destructive
      isLoading={loading}
      handleConfirm={handleSignOut}
      className="sm:max-w-sm"
    />
  );
}

import { useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { useAuth } from "@/context/auth-provider";
import { SignOutDialog } from "@/components/sign-out-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContentSection } from "../components/content-section";

export function AccountSettings() {
  const { user, expiresAt } = useAuth();
  const [signOutOpen, setSignOutOpen] = useState(false);

  const formattedExpiry = expiresAt
    ? new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })
    : "—";

  return (
    <ContentSection title="账户与会话" desc="查看当前 OIDC 管理员身份凭证、会话有效期与安全退出入口。">
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">管理员身份信息</CardTitle>
              <CardDescription>通过统一身份认证（OIDC PKCE）签发的管理会话</CardDescription>
            </div>
            <Badge variant="secondary" className="gap-1">
              <ShieldCheck className="size-3.5 text-emerald-500" />
              已认证
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <dt className="text-xs text-muted-foreground">显示名称</dt>
                <dd className="mt-1 font-medium">{user?.displayName || "—"}</dd>
              </div>
              <div className="rounded-lg border p-3">
                <dt className="text-xs text-muted-foreground">邮箱地址</dt>
                <dd className="mt-1 font-medium">{user?.email || "—"}</dd>
              </div>
              <div className="rounded-lg border p-3 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Subject (LINGUIST_OIDC_ADMIN_SUB)</dt>
                <dd className="mono mt-1 text-xs break-all">{user?.subject || "—"}</dd>
              </div>
              <div className="rounded-lg border p-3 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">会话过期时间</dt>
                <dd className="mono mt-1 text-xs">{formattedExpiry}</dd>
              </div>
            </dl>

            <div className="flex justify-end pt-2">
              <Button
                variant="destructive"
                className="gap-2"
                onClick={() => {
                  setSignOutOpen(true);
                }}
              >
                <LogOut className="size-4" />
                退出当前会话
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </ContentSection>
  );
}

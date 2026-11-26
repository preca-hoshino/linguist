import { AlertCircle, LogIn } from "lucide-react";
import { useLocation, useSearchParams } from "react-router";
import { LinguistLogo } from "@/assets/logo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "当前账号无权访问此控制台",
  oidc_unavailable: "统一身份认证服务暂不可用，请稍后重试",
  oidc_error: "统一身份认证失败，请重试",
  oidc_denied: "已取消统一身份认证",
  invalid_state: "登录状态已失效，请重新登录",
  invalid_request: "登录请求无效，请重试",
  auth_unavailable: "认证服务暂不可用，请稍后重试",
};

interface SignInPageProps {
  authUnavailable?: boolean;
}

export function SignInPage({ authUnavailable = false }: SignInPageProps) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const authError = searchParams.get("auth_error");
  const errorMessage = authError
    ? (AUTH_ERROR_MESSAGES[authError] ?? "登录失败，请重试")
    : authUnavailable
      ? AUTH_ERROR_MESSAGES.auth_unavailable
      : null;

  function startLogin() {
    const cleanParams = new URLSearchParams(location.search);
    cleanParams.delete("auth_error");
    const search = cleanParams.toString();
    const returnTo = `${location.pathname || "/"}${search ? `?${search}` : ""}` || "/";
    window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  return (
    <main className="container grid h-svh max-w-none items-center justify-center bg-muted/30">
      <div className="mx-auto flex w-full flex-col justify-center space-y-4 sm:w-[420px]">
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LinguistLogo className="size-5" />
          </div>
          <span className="text-xl font-semibold tracking-tight">Linguist</span>
        </div>

        <Card className="gap-4">
          <CardHeader className="text-center">
            <CardTitle className="text-lg tracking-tight">控制台登录</CardTitle>
            <CardDescription>
              使用统一身份认证（OIDC）登录网关遥测与配置管理控制台
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {errorMessage ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>认证提示</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="button" className="w-full gap-2" size="lg" onClick={startLogin}>
              <LogIn className="size-4" />
              使用统一身份登录
            </Button>
          </CardContent>
          <CardFooter className="justify-center border-t pt-4">
            <p className="text-center text-xs text-muted-foreground">
              受 OIDC PKCE 与 CSRF 会话保护 · Programmable OpenAI Chat Gateway
            </p>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}

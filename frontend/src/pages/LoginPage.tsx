import { useLocation, useSearchParams } from "react-router";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "当前账号无权访问此控制台",
  oidc_unavailable: "统一身份认证服务暂不可用，请稍后重试",
  oidc_error: "统一身份认证失败，请重试",
  oidc_denied: "已取消统一身份认证",
  invalid_state: "登录状态已失效，请重新登录",
  invalid_request: "登录请求无效，请重试",
  auth_unavailable: "认证服务暂不可用，请稍后重试",
};

interface LoginPageProps {
  authUnavailable?: boolean;
}

export function LoginPage({ authUnavailable = false }: LoginPageProps) {
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
    <main className="login-shell">
      <section className="section-card login-card" aria-labelledby="login-title">
        <div className="brand-group">
          <div className="brand-mark" aria-hidden="true">LG</div>
          <div>
            <h1 id="login-title" className="brand-title">Linguist 控制台</h1>
            <p className="brand-subtitle">请使用统一身份认证登录</p>
          </div>
        </div>
        {errorMessage ? (
          <div className="error-banner" role="alert">{errorMessage}</div>
        ) : null}
        <button type="button" className="btn-control active login-submit" onClick={startLogin}>
          使用统一身份登录
        </button>
      </section>
    </main>
  );
}

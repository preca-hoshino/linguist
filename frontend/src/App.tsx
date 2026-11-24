import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { fetchAuthMe, postLogout } from "./auth/api";
import type { AuthSession } from "./auth/api";
import { AuthContext } from "./auth/AuthContext";
import { CatalogPage } from "./catalog/CatalogPage";
import { catalogPath, catalogTitles } from "./catalog/navigation";
import type { CatalogResource } from "./catalog/types";
import { ConsoleSidebar } from "./components/ConsoleSidebar";
import { LoginPage } from "./pages/LoginPage";
import { TelemetryPage } from "./pages/TelemetryPage";
import "./styles/console.css";

const resources = Object.keys(catalogTitles) as CatalogResource[];

type AuthState = "loading" | "authenticated" | "unauthenticated" | "unavailable";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthMe(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status === "authenticated") {
          setSession(result.session);
          setAuthState("authenticated");
        } else {
          setSession(null);
          setAuthState(result.status);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSession(null);
        setAuthState("unavailable");
      });
    return () => { controller.abort(); };
  }, []);

  const handleUnauthorized = useCallback(() => {
    setSession(null);
    setAuthState("unauthenticated");
  }, []);

  const logout = useCallback(async () => {
    const csrfToken = session?.csrfToken ?? "";
    try {
      if (csrfToken) {
        await postLogout(csrfToken);
      }
    } finally {
      setSession(null);
      setAuthState("unauthenticated");
    }
  }, [session?.csrfToken]);

  const authValue = useMemo(() => ({
    user: session
      ? {
          subject: session.subject,
          email: session.email,
          displayName: session.displayName,
        }
      : null,
    csrfToken: session?.csrfToken ?? "",
    logout,
    handleUnauthorized,
  }), [session, logout, handleUnauthorized]);

  return (
    <BrowserRouter>
      <AuthContext.Provider value={authValue}>
        {authState === "loading" ? (
          <main className="login-shell">
            <p className="empty-state" role="status">正在验证登录状态…</p>
          </main>
        ) : authState !== "authenticated" ? (
          <LoginPage authUnavailable={authState === "unavailable"} />
        ) : (
          <>
            <a href="#main-content" className="console-skip">跳到内容</a>
            <div className="console-shell">
              <ConsoleSidebar />
              <div className="console-content">
                <Routes>
                  <Route path="/" element={<TelemetryPage />} />
                  {resources.map((resource) => (
                    <Route
                      key={resource}
                      path={catalogPath(resource)}
                      element={<CatalogPage key={resource} resource={resource} />}
                    />
                  ))}
                  <Route path="*" element={<Navigate replace to="/" />} />
                </Routes>
              </div>
            </div>
          </>
        )}
      </AuthContext.Provider>
    </BrowserRouter>
  );
}

export default App;

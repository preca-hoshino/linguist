import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthContext } from "@/context/auth-provider";
import { PreferencesProvider } from "@/context/preferences-provider";
import { ThemeProvider } from "@/context/theme-provider";
import { AuthenticatedLayout } from "@/components/layout/authenticated-layout";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchAuthMe, postLogout, type AuthSession } from "@/features/auth/api";
import { SignInPage } from "@/features/auth/sign-in";
import { CatalogPage } from "@/features/catalog";
import { catalogPath, catalogTitles, type CatalogResource } from "@/features/catalog/types";
import { DashboardPage } from "@/features/dashboard";
import { RequestLogsPage } from "@/features/logs";
import { DataMonitoringPage } from "@/features/monitoring";
import { SettingsPage } from "@/features/settings";
import { AccountSettings } from "@/features/settings/account";
import { AppearanceSettings } from "@/features/settings/appearance";
import { PreferencesSettings } from "@/features/settings/preferences";
import { SystemSettings } from "@/features/settings/system";

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
    return () => {
      controller.abort();
    };
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

  const authValue = useMemo(
    () => ({
      user: session
        ? {
            subject: session.subject,
            email: session.email,
            displayName: session.displayName,
          }
        : null,
      csrfToken: session?.csrfToken ?? "",
      expiresAt: session?.expiresAt ?? null,
      logout,
      handleUnauthorized,
    }),
    [session, logout, handleUnauthorized],
  );

  return (
    <ThemeProvider>
      <PreferencesProvider>
        <TooltipProvider delayDuration={150}>
          <BrowserRouter>
            <AuthContext.Provider value={authValue}>
              {authState === "loading" ? (
                <main className="grid h-svh place-items-center bg-background">
                  <p className="text-sm text-muted-foreground" role="status">
                    正在验证登录状态…
                  </p>
                </main>
              ) : authState !== "authenticated" ? (
                <SignInPage authUnavailable={authState === "unavailable"} />
              ) : (
                <AuthenticatedLayout>
                  <Routes>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/data" element={<DataMonitoringPage />} />
                    <Route path="/logs" element={<RequestLogsPage />} />
                    {resources.map((resource) => (
                      <Route
                        key={resource}
                        path={catalogPath(resource)}
                        element={<CatalogPage key={resource} resource={resource} />}
                      />
                    ))}
                    <Route path="/settings" element={<SettingsPage />}>
                      <Route index element={<AppearanceSettings />} />
                      <Route path="preferences" element={<PreferencesSettings />} />
                      <Route path="account" element={<AccountSettings />} />
                      <Route path="system" element={<SystemSettings />} />
                    </Route>
                    <Route path="*" element={<Navigate replace to="/" />} />
                  </Routes>
                </AuthenticatedLayout>
              )}
              <Toaster position="top-right" richColors closeButton />
            </AuthContext.Provider>
          </BrowserRouter>
        </TooltipProvider>
      </PreferencesProvider>
    </ThemeProvider>
  );
}

export default App;

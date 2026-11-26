export interface AuthUser {
  subject: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthSession {
  authenticated: true;
  subject: string;
  email: string | null;
  displayName: string | null;
  csrfToken: string;
  expiresAt: string;
}

export type AuthCheckResult =
  | { status: "authenticated"; session: AuthSession }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

export async function fetchAuthMe(signal?: AbortSignal): Promise<AuthCheckResult> {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
    signal,
  });
  if (response.status === 401) {
    return { status: "unauthenticated" };
  }
  if (response.status === 503) {
    return { status: "unavailable" };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} checking auth session`);
  }
  const data = (await response.json()) as Partial<AuthSession>;
  if (data.authenticated !== true || !data.subject || !data.csrfToken || !data.expiresAt) {
    return { status: "unauthenticated" };
  }
  return {
    status: "authenticated",
    session: {
      authenticated: true,
      subject: data.subject,
      email: data.email ?? null,
      displayName: data.displayName ?? null,
      csrfToken: data.csrfToken,
      expiresAt: data.expiresAt,
    },
  };
}

export async function postLogout(csrfToken: string): Promise<void> {
  const response = await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "X-CSRF-Token": csrfToken,
    },
  });
  if (!response.ok && response.status !== 401) {
    throw new Error(`HTTP ${response.status} logging out`);
  }
}

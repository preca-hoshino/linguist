import { createContext, useContext } from "react";
import type { AuthUser } from "@/features/auth/api";

export interface AuthContextValue {
  user: AuthUser | null;
  csrfToken: string;
  expiresAt: string | null;
  logout: () => Promise<void>;
  handleUnauthorized: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthContext.Provider");
  }
  return value;
}

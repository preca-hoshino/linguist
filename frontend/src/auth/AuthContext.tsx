import { createContext, useContext } from "react";
import type { AuthUser } from "./api";

export interface AuthContextValue {
  user: AuthUser | null;
  csrfToken: string;
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

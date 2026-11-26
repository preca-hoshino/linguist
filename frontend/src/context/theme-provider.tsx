import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getCookie, removeCookie, setCookie } from "@/lib/cookies";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = Exclude<Theme, "system">;

const DEFAULT_THEME: Theme = "system";
const THEME_COOKIE_NAME = "linguist-ui-theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeProviderState {
  defaultTheme: Theme;
  resolvedTheme: ResolvedTheme;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resetTheme: () => void;
}

const ThemeContext = createContext<ThemeProviderState | null>(null);

function parseTheme(raw: string | undefined, fallback: Theme): Theme {
  if (raw === "dark" || raw === "light" || raw === "system") return raw;
  return fallback;
}

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  storageKey = THEME_COOKIE_NAME,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    parseTheme(getCookie(storageKey), defaultTheme),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      setSystemDark(mediaQuery.matches);
    };
    setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  const contextValue = useMemo<ThemeProviderState>(
    () => ({
      defaultTheme,
      resolvedTheme,
      theme,
      setTheme: (next) => {
        setCookie(storageKey, next, THEME_COOKIE_MAX_AGE);
        setThemeState(next);
      },
      resetTheme: () => {
        removeCookie(storageKey);
        setThemeState(defaultTheme);
      },
    }),
    [defaultTheme, resolvedTheme, storageKey, theme],
  );

  return <ThemeContext value={contextValue}>{children}</ThemeContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { TimeRangeKey } from "@/features/monitoring/types";

export type TableDensity = "comfortable" | "compact";
export type PollingIntervalMs = 0 | 5000 | 15000 | 30000 | 60000;
export type LogsPageSize = 20 | 50 | 100;

export interface UserPreferences {
  pollingIntervalMs: PollingIntervalMs;
  defaultMonitoringRange: TimeRangeKey;
  defaultLogsPageSize: LogsPageSize;
  tableDensity: TableDensity;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorMinimap: boolean;
}

const STORAGE_KEY = "linguist-ui-preferences";

const DEFAULT_PREFERENCES: UserPreferences = {
  pollingIntervalMs: 5000,
  defaultMonitoringRange: "24h",
  defaultLogsPageSize: 20,
  tableDensity: "comfortable",
  editorFontSize: 13,
  editorWordWrap: true,
  editorMinimap: false,
};

function loadPreferences(): UserPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      pollingIntervalMs:
        parsed.pollingIntervalMs === 0 ||
        parsed.pollingIntervalMs === 5000 ||
        parsed.pollingIntervalMs === 15000 ||
        parsed.pollingIntervalMs === 30000 ||
        parsed.pollingIntervalMs === 60000
          ? parsed.pollingIntervalMs
          : DEFAULT_PREFERENCES.pollingIntervalMs,
      defaultMonitoringRange:
        parsed.defaultMonitoringRange === "1h" ||
        parsed.defaultMonitoringRange === "6h" ||
        parsed.defaultMonitoringRange === "24h" ||
        parsed.defaultMonitoringRange === "7d" ||
        parsed.defaultMonitoringRange === "30d" ||
        parsed.defaultMonitoringRange === "90d"
          ? parsed.defaultMonitoringRange
          : DEFAULT_PREFERENCES.defaultMonitoringRange,
      defaultLogsPageSize:
        parsed.defaultLogsPageSize === 20 ||
        parsed.defaultLogsPageSize === 50 ||
        parsed.defaultLogsPageSize === 100
          ? parsed.defaultLogsPageSize
          : DEFAULT_PREFERENCES.defaultLogsPageSize,
      tableDensity:
        parsed.tableDensity === "compact" || parsed.tableDensity === "comfortable"
          ? parsed.tableDensity
          : DEFAULT_PREFERENCES.tableDensity,
      editorFontSize:
        typeof parsed.editorFontSize === "number" &&
        parsed.editorFontSize >= 11 &&
        parsed.editorFontSize <= 20
          ? parsed.editorFontSize
          : DEFAULT_PREFERENCES.editorFontSize,
      editorWordWrap:
        typeof parsed.editorWordWrap === "boolean"
          ? parsed.editorWordWrap
          : DEFAULT_PREFERENCES.editorWordWrap,
      editorMinimap:
        typeof parsed.editorMinimap === "boolean"
          ? parsed.editorMinimap
          : DEFAULT_PREFERENCES.editorMinimap,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

interface PreferencesContextValue {
  preferences: UserPreferences;
  updatePreferences: (patch: Partial<UserPreferences>) => void;
  resetPreferences: () => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<UserPreferences>(loadPreferences);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Ignore storage quota errors.
    }
    window.document.documentElement.dataset.density = preferences.tableDensity;
  }, [preferences]);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      updatePreferences: (patch) => {
        setPreferences((prev) => ({ ...prev, ...patch }));
      },
      resetPreferences: () => {
        setPreferences(DEFAULT_PREFERENCES);
      },
    }),
    [preferences],
  );

  return <PreferencesContext value={value}>{children}</PreferencesContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within PreferencesProvider");
  }
  return ctx;
}

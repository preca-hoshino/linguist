import { createContext, useContext, useMemo, useState } from "react";
import { getCookie, setCookie } from "@/lib/cookies";

export type Collapsible = "offcanvas" | "icon" | "none";
export type Variant = "inset" | "sidebar" | "floating";

const LAYOUT_COLLAPSIBLE_COOKIE_NAME = "layout_collapsible";
const LAYOUT_VARIANT_COOKIE_NAME = "layout_variant";
const LAYOUT_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

const DEFAULT_VARIANT: Variant = "inset";
const DEFAULT_COLLAPSIBLE: Collapsible = "icon";

interface LayoutContextType {
  resetLayout: () => void;
  defaultCollapsible: Collapsible;
  collapsible: Collapsible;
  setCollapsible: (collapsible: Collapsible) => void;
  defaultVariant: Variant;
  variant: Variant;
  setVariant: (variant: Variant) => void;
}

const LayoutContext = createContext<LayoutContextType | null>(null);

function parseCollapsible(raw: string | undefined): Collapsible {
  if (raw === "offcanvas" || raw === "icon" || raw === "none") return raw;
  return DEFAULT_COLLAPSIBLE;
}

function parseVariant(raw: string | undefined): Variant {
  if (raw === "inset" || raw === "sidebar" || raw === "floating") return raw;
  return DEFAULT_VARIANT;
}

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [collapsible, setCollapsibleState] = useState<Collapsible>(() =>
    parseCollapsible(getCookie(LAYOUT_COLLAPSIBLE_COOKIE_NAME)),
  );
  const [variant, setVariantState] = useState<Variant>(() =>
    parseVariant(getCookie(LAYOUT_VARIANT_COOKIE_NAME)),
  );

  const contextValue = useMemo<LayoutContextType>(
    () => ({
      defaultCollapsible: DEFAULT_COLLAPSIBLE,
      collapsible,
      setCollapsible: (next) => {
        setCollapsibleState(next);
        setCookie(LAYOUT_COLLAPSIBLE_COOKIE_NAME, next, LAYOUT_COOKIE_MAX_AGE);
      },
      defaultVariant: DEFAULT_VARIANT,
      variant,
      setVariant: (next) => {
        setVariantState(next);
        setCookie(LAYOUT_VARIANT_COOKIE_NAME, next, LAYOUT_COOKIE_MAX_AGE);
      },
      resetLayout: () => {
        setCollapsibleState(DEFAULT_COLLAPSIBLE);
        setVariantState(DEFAULT_VARIANT);
        setCookie(LAYOUT_COLLAPSIBLE_COOKIE_NAME, DEFAULT_COLLAPSIBLE, LAYOUT_COOKIE_MAX_AGE);
        setCookie(LAYOUT_VARIANT_COOKIE_NAME, DEFAULT_VARIANT, LAYOUT_COOKIE_MAX_AGE);
      },
    }),
    [collapsible, variant],
  );

  return <LayoutContext value={contextValue}>{children}</LayoutContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLayout(): LayoutContextType {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error("useLayout must be used within a LayoutProvider");
  }
  return context;
}

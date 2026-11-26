import { useState } from "react";
import { cn } from "@/lib/utils";

interface LobeIconProps {
  slug: string;
  label: string;
  size?: number;
  className?: string;
}

const PALETTE = ["#4B7FFF", "#0EA5E9", "#10B981", "#6366F1", "#F59E0B", "#EC4899"] as const;

function monogramColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? "#4B7FFF";
}

export function LobeIcon({ slug, label, size = 20, className }: LobeIconProps) {
  const normalized = slug.trim().toLowerCase().replace(/\.svg$/, "");
  const fallbackBase = normalized.endsWith("-color")
    ? normalized.slice(0, -"-color".length)
    : "";

  const [step, setStep] = useState<"primary" | "mono" | "badge">(
    normalized ? "primary" : "badge",
  );

  if (step === "badge") {
    const ch = (label.trim().charAt(0) || slug.trim().charAt(0) || "M").toUpperCase();
    return (
      <span
        aria-label={label}
        className={cn(
          "inline-grid shrink-0 place-items-center font-semibold text-white",
          className,
        )}
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(4, Math.round(size * 0.28)),
          backgroundColor: monogramColor(label || slug),
          fontSize: Math.max(10, Math.round(size * 0.55)),
        }}
      >
        {ch}
      </span>
    );
  }

  const activeSlug = step === "primary" ? normalized : fallbackBase;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-muted/60 p-0.5 dark:bg-muted/80",
        className,
      )}
      style={{ width: size + 4, height: size + 4 }}
    >
      <img
        src={`/icons/${encodeURIComponent(activeSlug)}.svg`}
        alt={label}
        width={size}
        height={size}
        className="object-contain"
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(3, Math.round(size * 0.2)),
        }}
        onError={() => {
          if (step === "primary" && fallbackBase) {
            setStep("mono");
          } else {
            setStep("badge");
          }
        }}
      />
    </span>
  );
}

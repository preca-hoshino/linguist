import { useState } from "react";

interface LobeIconProps {
  slug: string;
  label: string;
  size?: number;
}

function monogramColor(seed: string): string {
  const palette = ["#4B7FFF", "#0EA5E9", "#10B981", "#6366F1", "#F59E0B", "#EC4899"];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length] ?? "#4B7FFF";
}

export function LobeIcon({ slug, label, size = 20 }: LobeIconProps) {
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
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(4, Math.round(size * 0.28)),
          backgroundColor: monogramColor(label || slug),
          color: "#ffffff",
          display: "inline-grid",
          placeItems: "center",
          fontSize: Math.max(10, Math.round(size * 0.55)),
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {ch}
      </span>
    );
  }

  const activeSlug = step === "primary" ? normalized : fallbackBase;

  return (
    <img
      src={`/icons/${encodeURIComponent(activeSlug)}.svg`}
      alt={label}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.24)),
        objectFit: "contain",
        flexShrink: 0,
      }}
      onError={() => {
        if (step === "primary" && fallbackBase) {
          setStep("mono");
        } else {
          setStep("badge");
        }
      }}
    />
  );
}

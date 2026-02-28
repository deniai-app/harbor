"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

type ThemeMode = "light" | "dark" | "system";

const LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};
const ICONS: Record<ThemeMode, string> = {
  light: "☀️",
  dark: "🌙",
  system: "💻",
};

function getThemeMode(theme: string | undefined): ThemeMode {
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }
  return "system";
}

function getNextTheme(theme: ThemeMode): ThemeMode {
  if (theme === "light") {
    return "dark";
  }
  if (theme === "dark") {
    return "system";
  }
  return "light";
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const currentTheme = getThemeMode(theme);
  const nextTheme = getNextTheme(currentTheme);

  return (
    <button
      aria-label={`Current theme ${LABELS[currentTheme]}. Switch to ${LABELS[nextTheme]}`}
      className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm hover:bg-muted"
      onClick={() => setTheme(nextTheme)}
      type="button"
    >
      {ICONS[currentTheme]} {LABELS[currentTheme]}
    </button>
  );
}

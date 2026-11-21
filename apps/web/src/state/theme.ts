export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "kiln.theme";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(pref: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Ignore storage errors in restricted environments
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? getSystemTheme() : pref;
}

export function applyThemeToDocument(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themePref = pref;
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", resolved === "light" ? "#f7f5f0" : "#121110");
    }
  }
  return resolved;
}

export function subscribeSystemThemeChange(
  onChange: (systemTheme: ResolvedTheme) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  const handleChange = (): void => {
    onChange(mql.matches ? "light" : "dark");
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(handleChange);
    return () => mql.removeListener(handleChange);
  }
  return () => {};
}

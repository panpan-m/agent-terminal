import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  parseCustomTheme,
  resolveThemeSpec,
  type ThemeId,
  type ThemeSpec,
} from "@/lib/themeSpecs";

export type Theme = ThemeId;
export const THEMES: Theme[] = ["pixel", "sheet", "dark", "light", "custom"];
const STORAGE_KEY = "tio-theme";
const CUSTOM_KEY = "tio-theme-custom";
/** Marks that the stored theme was chosen by a build that knows this theme set. */
const VERSION_KEY = "tio-theme-v2";

export function isTheme(value: unknown): value is Theme {
  if (typeof value !== "string") return false;
  return value === "custom" || value in BUILTIN_THEMES;
}

export function isLightTheme(theme: Theme): boolean {
  if (theme === "custom") return resolveThemeSpec("custom", loadCustomTheme()).colorScheme === "light";
  return BUILTIN_THEMES[theme].colorScheme === "light";
}

function loadCustomTheme(): ThemeSpec | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return null;
    return parseCustomTheme(raw).spec;
  } catch {
    return null;
  }
}

/** Resolve the active spec (built-in or stored custom) for any theme id. */
export function activeThemeSpec(theme: Theme): ThemeSpec {
  return resolveThemeSpec(theme, loadCustomTheme());
}

/** Write every spec variable onto <html>; previous theme keys are overwritten. */
function applyTheme(theme: Theme) {
  const spec = activeThemeSpec(theme);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = spec.colorScheme;
  // legacy hook for anything still keying off the class
  root.classList.toggle("light", theme === "light" || (theme === "custom" && spec.colorScheme === "light"));
  const applied = new Set(Object.keys(spec.vars));
  for (const [key, value] of Object.entries(spec.vars)) {
    root.style.setProperty(key, value);
  }
  // drop keys a previous (richer) theme may have left behind
  for (const key of Array.from(root.style)) {
    if (key.startsWith("--") && !applied.has(key)) root.style.removeProperty(key);
  }
  return spec;
}

/**
 * Only honour a stored theme once this build has written the version marker.
 * Before that, `tio-theme` can only hold a value from an older theme set, so
 * the first load of a new build lands on the default instead of restoring a
 * theme this build does not know.
 */
function storedTheme(): Theme | null {
  try {
    if (window.localStorage.getItem(VERSION_KEY) !== "1") return null;
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Apply the saved theme before React renders to avoid a flash of the wrong palette. */
function initialTheme(): Theme {
  const theme = storedTheme() ?? DEFAULT_THEME_ID;
  applyTheme(theme);
  return theme;
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void; toggle: () => void } | null>(
  null,
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
      window.localStorage.setItem(VERSION_KEY, "1");
    } catch {
      /* storage disabled */
    }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((value) => THEMES[(THEMES.indexOf(value) + 1) % THEMES.length]),
    [],
  );
  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}

/** Persist a validated custom spec and switch to it. */
export function saveCustomTheme(spec: ThemeSpec): void {
  try {
    window.localStorage.setItem(
      CUSTOM_KEY,
      JSON.stringify({ label: spec.label, colorScheme: spec.colorScheme, vars: spec.vars, term: spec.term }),
    );
  } catch {
    /* storage disabled */
  }
}

/** JSON draft of the current custom theme (or the merged baseline) for the editor. */
export function customThemeDraft(): string {
  const spec = activeThemeSpec("custom");
  return JSON.stringify(
    { label: spec.label, colorScheme: spec.colorScheme, vars: spec.vars, term: spec.term },
    null,
    2,
  );
}

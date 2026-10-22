import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "pixel" | "sheet" | "dark" | "light";

export const THEMES: Theme[] = ["pixel", "sheet", "dark", "light"];
export const THEME_LABELS: Record<Theme, string> = {
  pixel: "pixel",
  sheet: "sheet",
  dark: "dark",
  light: "light",
};
const STORAGE_KEY = "tio-theme";
/** Marks that the stored theme was chosen by a build that knows all four themes. */
const VERSION_KEY = "tio-theme-v2";
const DEFAULT_THEME: Theme = "pixel";

export function isTheme(value: unknown): value is Theme {
  return value === "pixel" || value === "sheet" || value === "dark" || value === "light";
}

export function isLightTheme(theme: Theme): boolean {
  return theme === "light" || theme === "sheet";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = isLightTheme(theme) ? "light" : "dark";
  // legacy hook for anything still keying off the class
  root.classList.toggle("light", theme === "light");
}

/**
 * Only honour a stored theme once this build has written the version marker.
 * Before that, `tio-theme` can only hold a value from the old dark/light toggle,
 * so the first load of the themed build lands on the new default instead of
 * silently restoring the old UI.
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
  const theme = storedTheme() ?? DEFAULT_THEME;
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

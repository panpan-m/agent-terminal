import { THEMES, THEME_LABELS, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const TITLES: Record<Theme, string> = {
  pixel: "8-bit phosphor console",
  sheet: "paper engineering drawing",
  dark: "classic dark",
  light: "classic light",
};

/** Four-way theme picker; the choice persists in localStorage. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div className={cn("theme-switch", className)} role="group" aria-label="Theme">
      {THEMES.map((item) => (
        <button
          key={item}
          type="button"
          title={TITLES[item]}
          aria-pressed={theme === item}
          onClick={() => setTheme(item)}
        >
          {THEME_LABELS[item]}
        </button>
      ))}
    </div>
  );
}

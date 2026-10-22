/** xterm palettes come from the theme specs; the terminal follows the app theme. */

import type { ITheme } from "@xterm/xterm";

import { activeThemeSpec, type Theme } from "@/lib/theme";

export function terminalTheme(theme: Theme): ITheme {
  return activeThemeSpec(theme).term as ITheme;
}

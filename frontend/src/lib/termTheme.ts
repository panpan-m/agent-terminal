import type { ITheme } from "@xterm/xterm";

import type { Theme } from "@/lib/theme";

const DARK: ITheme = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#34d399",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#f4f4f5",
};

const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#047857",
  cursorAccent: "#ffffff",
  selectionBackground: "#bfdbfe",
  black: "#18181b",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#18181b",
};

/** Phosphor green on the pixel theme's black-green. */
const PIXEL: ITheme = {
  background: "#070a07",
  foreground: "#b9e6a6",
  cursor: "#8bf77e",
  cursorAccent: "#070a07",
  selectionBackground: "#24401c",
  black: "#0b1009",
  red: "#ff6f61",
  green: "#8bf77e",
  yellow: "#ffc457",
  blue: "#7fb8ff",
  magenta: "#d99bff",
  cyan: "#6fd7e0",
  white: "#dcf0cf",
  brightBlack: "#4f6f44",
  brightRed: "#ff8b7e",
  brightGreen: "#a4ff96",
  brightYellow: "#ffd98c",
  brightBlue: "#a8c8ff",
  brightMagenta: "#ecc0ff",
  brightCyan: "#a8e9f0",
  brightWhite: "#f6fff0",
};

/** Ink on drawing paper. */
const SHEET: ITheme = {
  background: "#f7f4ed",
  foreground: "#191b1a",
  cursor: "#a8321f",
  cursorAccent: "#f7f4ed",
  selectionBackground: "#e3d9c6",
  black: "#191b1a",
  red: "#a8321f",
  green: "#3f6b3a",
  yellow: "#8a5a00",
  blue: "#2f4d78",
  magenta: "#6b3f7a",
  cyan: "#2a6a72",
  white: "#d8d2c3",
  brightBlack: "#6b6d66",
  brightRed: "#c2402a",
  brightGreen: "#4d7f45",
  brightYellow: "#a35a00",
  brightBlue: "#3a5f92",
  brightMagenta: "#845095",
  brightCyan: "#357f88",
  brightWhite: "#191b1a",
};

const TERMINAL_THEMES: Record<Theme, ITheme> = {
  pixel: PIXEL,
  sheet: SHEET,
  dark: DARK,
  light: LIGHT,
};

export function terminalTheme(theme: Theme): ITheme {
  return TERMINAL_THEMES[theme];
}

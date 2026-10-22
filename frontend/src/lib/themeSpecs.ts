/**
 * Themes as data (webssh2-style): one layout, many JSON specs.
 *
 * A spec is a flat, JSON-serializable object.  `vars` are CSS custom
 * properties written onto <html> at runtime — including the Tailwind v4
 * palette variables (`--color-zinc-*`, `--color-emerald-*`, radii, shadows,
 * type scale), which is how one layout re-skins without touching components.
 * `term` is the xterm.js palette for the same look.  Custom themes use the
 * same schema and are merged over the dark baseline, so a partial spec works.
 */

import type { ITheme } from "@xterm/xterm";

export type ThemeId = "pixel" | "sheet" | "dark" | "light" | "custom";

export interface ThemeSpec {
  id?: string;
  label: string;
  colorScheme: "dark" | "light";
  /** CSS custom properties applied to <html>. */
  vars: Record<string, string>;
  /** xterm.js palette; defaults come from the dark baseline when partial. */
  term?: Partial<ITheme>;
}

const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif';

/* ------------------------------------------------------------------ dark */
const DARK_TERM: ITheme = {
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

const DARK: ThemeSpec = {
  label: "dark",
  colorScheme: "dark",
  vars: {
    "--app-bg": "#09090b",
    "--app-fg": "#f4f4f5",
    "--scroll-thumb": "#27272a",
    "--scroll-thumb-hover": "#3f3f46",
    "--scroll-border": "#09090b",
    "--glow-emerald": "rgba(16, 185, 129, 0.08)",
    "--glow-blue": "rgba(59, 130, 246, 0.07)",
    "--app-font": SYSTEM_SANS,
  },
  term: DARK_TERM,
};

/* ----------------------------------------------------------------- light */
const LIGHT: ThemeSpec = {
  label: "light",
  colorScheme: "light",
  vars: {
    "--app-bg": "#f8fafc",
    "--app-fg": "#0f172a",
    "--scroll-thumb": "#cbd5e1",
    "--scroll-thumb-hover": "#94a3b8",
    "--scroll-border": "#f8fafc",
    "--glow-emerald": "rgba(16, 185, 129, 0.12)",
    "--glow-blue": "rgba(59, 130, 246, 0.1)",
    "--app-font": SYSTEM_SANS,

    "--color-zinc-50": "#020617",
    "--color-zinc-100": "#0f172a",
    "--color-zinc-200": "#1e293b",
    "--color-zinc-300": "#334155",
    "--color-zinc-400": "#475569",
    "--color-zinc-500": "#64748b",
    "--color-zinc-600": "#94a3b8",
    "--color-zinc-700": "#cbd5e1",
    "--color-zinc-800": "#e2e8f0",
    "--color-zinc-900": "#f1f5f9",
    "--color-zinc-950": "#f8fafc",

    "--color-emerald-200": "#065f46",
    "--color-emerald-300": "#047857",
    "--color-emerald-400": "#059669",
    "--color-emerald-500": "#047857",
    "--color-emerald-600": "#065f46",
    "--color-red-400": "#b91c1c",
    "--color-amber-300": "#b45309",
    "--color-amber-400": "#b45309",
    "--color-blue-300": "#1d4ed8",
    "--color-blue-400": "#1d4ed8",
  },
  term: {
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
  },
};

/* ----------------------------------------------------------------- pixel */
const PIXEL: ThemeSpec = {
  label: "pixel",
  colorScheme: "dark",
  vars: {
    "--app-bg": "#070a07",
    "--app-fg": "#cfeec0",
    "--scroll-thumb": "#24351f",
    "--scroll-thumb-hover": "#3a4f33",
    "--scroll-border": "#070a07",
    "--app-font":
      '"VT323", ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans SC", monospace',
    "--font-sans":
      '"Silkscreen", ui-monospace, Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans SC", monospace',
    "--font-mono":
      '"VT323", ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans SC", monospace',

    "--color-zinc-950": "#070a07",
    "--color-zinc-900": "#0f150e",
    "--color-zinc-800": "#24351f",
    "--color-zinc-700": "#35502c",
    "--color-zinc-600": "#6f9165",
    "--color-zinc-500": "#7d9b75",
    "--color-zinc-400": "#a3bf96",
    "--color-zinc-300": "#c3d9b7",
    "--color-zinc-200": "#dcf0cf",
    "--color-zinc-100": "#ecffe0",
    "--color-zinc-50": "#f6fff0",

    "--color-emerald-200": "#dcffd0",
    "--color-emerald-300": "#c0ffb0",
    "--color-emerald-400": "#a4ff96",
    "--color-emerald-500": "#8bf77e",
    "--color-emerald-600": "#5fc253",
    "--color-emerald-700": "#3f8a37",

    "--color-amber-300": "#ffd98c",
    "--color-amber-400": "#ffc457",
    "--color-amber-500": "#e0a233",
    "--color-red-300": "#ffb0a6",
    "--color-red-400": "#ff8b7e",
    "--color-red-500": "#ff6f61",
    "--color-red-600": "#d94f42",
    "--color-sky-300": "#a8e9f0",
    "--color-sky-400": "#6fd7e0",
    "--color-sky-500": "#3fb8c4",

    "--radius-sm": "0px",
    "--radius-md": "0px",
    "--radius-lg": "0px",
    "--radius-xl": "0px",
    "--radius-2xl": "0px",
    "--radius-3xl": "0px",

    "--shadow-2xs": "1px 1px 0 #000",
    "--shadow-xs": "2px 2px 0 #000",
    "--shadow-sm": "2px 2px 0 #000",
    "--shadow-md": "3px 3px 0 #000",
    "--shadow-lg": "4px 4px 0 #000",
    "--shadow-xl": "5px 5px 0 #000",
    "--shadow-2xl": "6px 6px 0 #000",

    "--text-xs": "13.5px",
    "--text-xs--line-height": "1.4",
    "--text-sm": "15.5px",
    "--text-sm--line-height": "1.4",
    "--text-base": "17px",
    "--text-base--line-height": "1.4",
    "--text-lg": "19px",
    "--text-lg--line-height": "1.3",
    "--text-xl": "23px",
    "--text-xl--line-height": "1.2",
    "--text-2xl": "28px",
    "--text-2xl--line-height": "1.15",
    "--text-3xl": "34px",
    "--text-3xl--line-height": "1.1",
  },
  term: {
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
  },
};

/* ----------------------------------------------------------------- sheet */
const SHEET: ThemeSpec = {
  label: "sheet",
  colorScheme: "light",
  vars: {
    "--app-bg": "#f7f4ed",
    "--app-fg": "#191b1a",
    "--scroll-thumb": "#cfc8b8",
    "--scroll-thumb-hover": "#b6ae9c",
    "--scroll-border": "#f7f4ed",
    "--app-font": '"Archivo", ui-sans-serif, system-ui, sans-serif',
    "--font-sans": '"Archivo", ui-sans-serif, system-ui, sans-serif',
    "--font-mono": '"Space Mono", ui-monospace, Consolas, monospace',

    "--color-zinc-950": "#f7f4ed",
    "--color-zinc-900": "#fbf9f4",
    "--color-zinc-800": "#d8d2c3",
    "--color-zinc-700": "#bfb8a6",
    "--color-zinc-600": "#6f6a5c",
    "--color-zinc-500": "#6b6d66",
    "--color-zinc-400": "#4c4f4b",
    "--color-zinc-300": "#35383a",
    "--color-zinc-200": "#24272a",
    "--color-zinc-100": "#191b1a",
    "--color-zinc-50": "#101210",

    /* the accent becomes ink: solid buttons are black, live states are vermilion */
    "--color-emerald-200": "#8c2a18",
    "--color-emerald-300": "#a8321f",
    "--color-emerald-400": "#3a3d3a",
    "--color-emerald-500": "#191b1a",
    "--color-emerald-600": "#101210",
    "--color-emerald-700": "#0a0b0a",

    "--color-amber-300": "#8a4a00",
    "--color-amber-400": "#a35a00",
    "--color-amber-500": "#8a4a00",
    "--color-red-300": "#8c2a18",
    "--color-red-400": "#a8321f",
    "--color-red-500": "#a8321f",
    "--color-red-600": "#8c2a18",
    "--color-sky-300": "#24406a",
    "--color-sky-400": "#2f4d78",
    "--color-sky-500": "#24406a",

    "--radius-sm": "0px",
    "--radius-md": "0px",
    "--radius-lg": "0px",
    "--radius-xl": "0px",
    "--radius-2xl": "0px",
    "--radius-3xl": "0px",

    "--shadow-2xs": "none",
    "--shadow-xs": "none",
    "--shadow-sm": "none",
    "--shadow-md": "none",
    "--shadow-lg": "none",
    "--shadow-xl": "none",
    "--shadow-2xl": "none",
  },
  term: {
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
  },
};

export const BUILTIN_THEMES: Record<Exclude<ThemeId, "custom">, ThemeSpec> = {
  pixel: PIXEL,
  sheet: SHEET,
  dark: DARK,
  light: LIGHT,
};

export const DEFAULT_THEME_ID: ThemeId = "pixel";

/** Resolve a spec (merged over the dark baseline) for a theme id. */
export function resolveThemeSpec(id: ThemeId, custom: ThemeSpec | null): ThemeSpec {
  if (id === "custom") {
    const merged = mergeSpec(DARK, custom ?? {});
    return { ...merged, id: "custom", label: custom?.label || "custom" };
  }
  const spec = BUILTIN_THEMES[id];
  return { ...spec, id };
}

/** Merge a (possibly partial) spec over the dark baseline. */
export function mergeSpec(base: ThemeSpec, override: Partial<ThemeSpec>): ThemeSpec {
  return {
    label: typeof override.label === "string" && override.label.trim() ? override.label.trim().slice(0, 24) : base.label,
    colorScheme: override.colorScheme === "light" ? "light" : "dark",
    vars: { ...base.vars, ...sanitizeVars(override.vars) },
    term: { ...base.term, ...sanitizeTerm(override.term) },
  };
}

function isHexish(value: string): boolean {
  return /^(#[0-9a-fA-F]{3,8}|[a-z-]+\(.*\)|".*"|[a-zA-Z][\w ,'-]*)$/.test(value);
}

function sanitizeVars(vars: unknown): Record<string, string> {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (!key.startsWith("--") || key.length > 64) continue;
    if (typeof value === "string" && value.length <= 200 && isHexish(value)) out[key] = value;
  }
  return out;
}

const TERM_KEYS = [
  "foreground",
  "background",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function sanitizeTerm(term: unknown): Partial<ITheme> {
  if (!term || typeof term !== "object" || Array.isArray(term)) return {};
  const out: Record<string, string> = {};
  for (const key of TERM_KEYS) {
    const value = (term as Record<string, unknown>)[key];
    if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)) out[key] = value;
  }
  return out as Partial<ITheme>;
}

/** Parse + validate a custom theme JSON document; returns null with a reason. */
export function parseCustomTheme(json: string): { spec: ThemeSpec | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (exc) {
    return { spec: null, error: `invalid JSON: ${(exc as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { spec: null, error: "the theme must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.vars !== undefined && Object.keys(sanitizeVars(obj.vars)).length === 0 && Object.keys(obj.vars ?? {}).length > 0) {
    return { spec: null, error: 'vars must map "--css-var" names to string values' };
  }
  if (obj.term !== undefined && Object.keys(obj.term ?? {}).length > 0 && Object.keys(sanitizeTerm(obj.term)).length === 0) {
    return { spec: null, error: "term colors must be #rrggbb strings" };
  }
  const spec = mergeSpec(DARK, obj as Partial<ThemeSpec>);
  return { spec: { ...spec, id: "custom" }, error: null };
}

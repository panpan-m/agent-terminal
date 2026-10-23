/**
 * Persisted terminal settings, shared by the serial and SSH terminals.
 * Theme is deliberately not here: the terminals follow the app theme.
 */

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  /** Prevent the browser from acting on Escape so vi always receives it. */
  captureEscape: boolean;
  /** Prevent the browser from acting on Ctrl+B (tmux prefix). */
  captureCtrlB: boolean;
  /** Extra keys to capture, e.g. "F11, Ctrl+T, Alt+D". */
  customCaptureKeys: string;
  /** Send ESC+CR on Shift+Enter (newline vs submit in TUIs). */
  shiftEnterNewline: boolean;
  /** On serial open, send `stty rows R cols C` so device TUIs draw correctly. */
  sttySync: boolean;
  /** Copy to the clipboard as soon as the selection changes. */
  autoCopy: boolean;
  /** Middle-click pastes from the clipboard. */
  middleClickPaste: boolean;
  /** Ctrl+Shift+C / Ctrl+Shift+V copy / paste. */
  clipboardShortcuts: boolean;
  /** Plain Ctrl+V pastes; off sends the terminal's ^V control character. */
  ctrlVPaste: boolean;
  /** Right-click in the terminal pastes (PuTTY-style). */
  rightClickPaste: boolean;
  /** Desktop pet rendered in the corner of the app. */
  petEnabled: boolean;
  /** Pet canvas size in CSS pixels. */
  petSize: number;
  /** Active pet model: "builtin" or an uploaded model id. */
  petModelId: string;
}

const STORAGE_KEY = "tio-terminal-settings";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 13,
  fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  cursorBlink: true,
  scrollback: 5000,
  captureEscape: false,
  captureCtrlB: false,
  customCaptureKeys: "",
  shiftEnterNewline: false,
  sttySync: true,
  autoCopy: true,
  middleClickPaste: true,
  clipboardShortcuts: true,
  ctrlVPaste: true,
  rightClickPaste: true,
  petEnabled: true,
  petSize: 168,
  petModelId: "builtin",
};

export function clampSettings(value: Partial<TerminalSettings>): Partial<TerminalSettings> {
  const out: Partial<TerminalSettings> = { ...value };
  if (out.fontSize !== undefined) out.fontSize = Math.min(72, Math.max(8, Math.round(out.fontSize)));
  if (out.scrollback !== undefined) out.scrollback = Math.min(200_000, Math.max(1, Math.round(out.scrollback)));
  if (out.petSize !== undefined) out.petSize = Math.min(288, Math.max(96, Math.round(out.petSize)));
  if (out.petModelId !== undefined) out.petModelId = String(out.petModelId).slice(0, 64) || "builtin";
  return out;
}

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TERMINAL_SETTINGS };
    return { ...DEFAULT_TERMINAL_SETTINGS, ...clampSettings(JSON.parse(raw) as Partial<TerminalSettings>) };
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS };
  }
}

const listeners = new Set<() => void>();
let current: TerminalSettings = loadTerminalSettings();

export function getTerminalSettings(): TerminalSettings {
  return current;
}

export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  current = { ...current, ...clampSettings(patch) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode; keep in-memory */
  }
  for (const listener of listeners) listener();
}

export function subscribeTerminalSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Parse "F11, Ctrl+T, Alt+D" into lowercase normalized tokens ("f11", "ctrl+t"). */
export function parseCaptureKeys(raw: string): string[] {
  return raw
    .split(/[,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

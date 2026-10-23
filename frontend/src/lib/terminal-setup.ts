/**
 * Shared xterm.js construction and enhancement for the serial and SSH
 * terminals: Unicode11 (CJK width), clickable links, clipboard integration,
 * configurable key capture and Shift+Enter mapping.  Behaviour flags are read
 * from the settings store at event time so changes apply without re-attaching.
 */

import type { ITheme, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";

import {
  getTerminalSettings,
  parseCaptureKeys,
  type TerminalSettings,
} from "@/lib/terminal-settings";

export function terminalOptions(settings: TerminalSettings, theme: ITheme) {
  return {
    cursorBlink: settings.cursorBlink,
    convertEol: false as const,
    allowProposedApi: true,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: 1.2,
    scrollback: settings.scrollback,
    theme,
  };
}

/** Apply the live-tunable options of the settings store to an open terminal. */
export function applyTerminalSettings(term: Terminal, settings: TerminalSettings): void {
  term.options.fontSize = settings.fontSize;
  term.options.fontFamily = settings.fontFamily;
  term.options.cursorBlink = settings.cursorBlink;
  term.options.scrollback = settings.scrollback;
}

let notifyBlockUntil = 0;

/**
 * Native bridge of the desktop shell.  WebView2 denies
 * ``navigator.clipboard`` read/write because pywebview never answers the
 * PermissionRequested event, so ``desktop.py`` exposes the Win32 clipboard
 * through a js bridge as a fallback — plus a native Save-As dialog and a
 * direct-to-disk download stream for the SFTP panel.
 */
export interface PyWebViewBridgeApi {
  read_clipboard?: () => Promise<string>;
  write_clipboard?: (text: string) => Promise<void>;
  pick_save_path?: (suggestedName: string) => Promise<string | null>;
  save_url_to?: (
    url: string,
    destPath: string,
    taskId: number,
    method?: "GET" | "POST",
    jsonBody?: Record<string, unknown> | null,
  ) => Promise<{ ok: boolean; bytes: number; path: string; error?: string; cancelled?: boolean }>;
  cancel_save?: (taskId: number) => Promise<void>;
}

export function pywebviewApi(): PyWebViewBridgeApi | undefined {
  return (window as { pywebview?: { api?: PyWebViewBridgeApi } }).pywebview?.api;
}

async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch (error) {
    const api = pywebviewApi();
    if (api?.read_clipboard) return await api.read_clipboard();
    throw error;
  }
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const api = pywebviewApi();
    if (api?.write_clipboard) {
      await api.write_clipboard(text);
      return;
    }
    throw error;
  }
}

function throttledNotify(
  notify: (message: string, tone?: "info" | "error" | "success") => void,
  message: string,
) {
  const now = Date.now();
  if (now < notifyBlockUntil) return;
  notifyBlockUntil = now + 1500;
  notify(message, "success");
}

function keyToken(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

export interface Enhancements {
  dispose: () => void;
}

/** True when the viewport sits at the bottom of the buffer (following live output). */
export function isTerminalAtBottom(term: Terminal): boolean {
  const buffer = term.buffer.active;
  return buffer.viewportY >= buffer.length - term.rows;
}

/**
 * Follow-output mode driven by the scrollbar: scrolling up pauses
 * ``scrollToBottom`` so the view stays where the user is reading; returning to
 * the bottom resumes it.  ``setAutoScroll`` receives the follow state.
 */
export function attachScrollFollow(term: Terminal, setAutoScroll: (value: boolean) => void) {
  const disposable = term.onScroll(() => setAutoScroll(isTerminalAtBottom(term)));
  return { dispose: () => disposable.dispose() };
}

/**
 * Rate-limited decision for ``overflow`` frames: when the server subscriber
 * queue dropped frames the data still lives in the ring buffer, so
 * reconnecting with the cursor replays the missing bytes.  One forced resync
 * per window; another overflow inside it means the ring itself wrapped and
 * the oldest bytes are gone for good.
 */
export function createOverflowResync(windowMs = 3000): () => boolean {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}

/**
 * Attach the shared enhancements to a terminal that already has Fit/Search
 * loaded.  ``sendData`` injects bytes into the session input path (used by the
 * Shift+Enter remap; xterm has no public input-injection API).
 */
export function attachTerminalEnhancements(
  term: Terminal,
  host: HTMLElement,
  notify: (message: string, tone?: "info" | "error" | "success") => void,
  sendData: (data: string) => void,
): Enhancements {
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon());

  // GPU renderer: one canvas instead of thousands of DOM rows, which keeps
  // the main thread free during fast output and scrollback scrolling.  Falls
  // back to the DOM renderer when WebGL is unavailable (RDP, VMs).
  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
    });
    term.loadAddon(webgl);
  } catch {
    webgl?.dispose();
    webgl = null;
  }

  // ------------------------------------------------------------ clipboard
  let selection = "";
  let copyTimer: number | undefined;
  const onSelectionChange = () => {
    selection = term.hasSelection() ? term.getSelection() : "";
    if (!selection || !getTerminalSettings().autoCopy) return;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      writeClipboardText(selection)
        .then(() => throttledNotify(notify, `copied ${selection.length} chars`))
        .catch(() => {
          /* clipboard blocked; Ctrl+Shift+C still works after a user gesture */
        });
    }, 350);
  };
  const selectionDisposable = term.onSelectionChange(onSelectionChange);

  const pasteFromClipboard = () => {
    readClipboardText()
      .then((text) => {
        if (text) {
          term.paste(text);
          throttledNotify(notify, `pasted ${text.length} chars`);
        }
      })
      .catch(() => notify("clipboard read failed; right-click ▸ Paste still works", "error"));
  };

  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1 || !getTerminalSettings().middleClickPaste) return;
    event.preventDefault();
    pasteFromClipboard();
  };
  host.addEventListener("auxclick", onAuxClick);

  // PuTTY-style: right-click pastes; copy stays covered by selection auto-copy.
  const onContextMenu = (event: MouseEvent) => {
    if (!getTerminalSettings().rightClickPaste) return;
    event.preventDefault();
    pasteFromClipboard();
  };
  host.addEventListener("contextmenu", onContextMenu);

  // ------------------------------------------------------- key handling
  term.attachCustomKeyEventHandler((event) => {
    const settings = getTerminalSettings();
    if (event.type !== "keydown") return true;

    // Plain Ctrl+V pastes, matching Windows terminal habits.  Unhandled,
    // xterm maps Ctrl+V to the ^V control character, sends it to the session
    // and cancels the event, so the browser paste never happens.
    if (
      settings.ctrlVPaste &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === "v"
    ) {
      event.preventDefault();
      pasteFromClipboard();
      return false;
    }

    // Ctrl+Shift+C / V: clipboard copy / paste (xterm binds neither by default).
    if (settings.clipboardShortcuts && event.ctrlKey && event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        event.preventDefault();
        writeClipboardText(term.getSelection())
          .then(() => throttledNotify(notify, "copied selection"))
          .catch(() => notify("clipboard write denied", "error"));
        return false;
      }
      if (key === "v") {
        event.preventDefault();
        pasteFromClipboard();
        return false;
      }
    }

    // Shift+Enter sends ESC+CR so TUIs (Claude Code & friends) can tell a
    // newline apart from "submit".
    if (
      settings.shiftEnterNewline &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      sendData("\x1b\r");
      return false;
    }

    return true;
  });

  // Capture list: keep these keys away from the browser (fullscreen, tab
  // close, address bar focus…) so they reach the PTY instead.
  const onCaptureKeyDown = (event: KeyboardEvent) => {
    if (!host.contains(event.target as Node)) return;
    const settings = getTerminalSettings();
    if (event.key === "Escape" && settings.captureEscape) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "b" &&
      settings.captureCtrlB
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (parseCaptureKeys(settings.customCaptureKeys).includes(keyToken(event))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener("keydown", onCaptureKeyDown, true);

  return {
    dispose: () => {
      window.clearTimeout(copyTimer);
      webgl?.dispose();
      window.removeEventListener("keydown", onCaptureKeyDown, true);
      host.removeEventListener("auxclick", onAuxClick);
      host.removeEventListener("contextmenu", onContextMenu);
      selectionDisposable.dispose();
    },
  };
}

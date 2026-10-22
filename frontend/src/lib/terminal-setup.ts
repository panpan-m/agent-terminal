/**
 * Shared xterm.js construction and enhancement for the serial and SSH
 * terminals: Unicode11 (CJK width), clickable links, clipboard integration,
 * configurable key capture and Shift+Enter mapping.  Behaviour flags are read
 * from the settings store at event time so changes apply without re-attaching.
 */

import type { ITheme, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
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

  // ------------------------------------------------------------ clipboard
  let selection = "";
  let copyTimer: number | undefined;
  const onSelectionChange = () => {
    selection = term.hasSelection() ? term.getSelection() : "";
    if (!selection || !getTerminalSettings().autoCopy) return;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      navigator.clipboard
        .writeText(selection)
        .then(() => throttledNotify(notify, `copied ${selection.length} chars`))
        .catch(() => {
          /* clipboard blocked; Ctrl+Shift+C still works after a user gesture */
        });
    }, 350);
  };
  const selectionDisposable = term.onSelectionChange(onSelectionChange);

  const pasteFromClipboard = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          term.paste(text);
          throttledNotify(notify, `pasted ${text.length} chars`);
        }
      })
      .catch(() => notify("clipboard read denied by the browser", "error"));
  };

  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1 || !getTerminalSettings().middleClickPaste) return;
    event.preventDefault();
    pasteFromClipboard();
  };
  host.addEventListener("auxclick", onAuxClick);

  // ------------------------------------------------------- key handling
  term.attachCustomKeyEventHandler((event) => {
    const settings = getTerminalSettings();
    if (event.type !== "keydown") return true;

    // Ctrl+Shift+C / V: clipboard copy / paste (xterm binds neither by default).
    if (settings.clipboardShortcuts && event.ctrlKey && event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        event.preventDefault();
        navigator.clipboard
          .writeText(term.getSelection())
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
      window.removeEventListener("keydown", onCaptureKeyDown, true);
      host.removeEventListener("auxclick", onAuxClick);
      selectionDisposable.dispose();
    },
  };
}

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Save, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger, Switch } from "@/components/ui/dialog";
import { Field, Input, Label, Select } from "@/components/ui/input";
import { customThemeDraft, saveCustomTheme, useTheme, THEMES } from "@/lib/theme";
import { parseCustomTheme } from "@/lib/themeSpecs";
import {
  DEFAULT_TERMINAL_SETTINGS,
  getTerminalSettings,
  updateTerminalSettings,
  type TerminalSettings,
} from "@/lib/terminal-settings";

const THEME_HINTS: Record<string, string> = {
  pixel: "8-bit phosphor console (default)",
  sheet: "paper engineering drawing",
  dark: "classic dark",
  light: "classic light",
  custom: "your JSON theme (edit below)",
};

/**
 * App settings: theme (dropdown), terminal appearance, keyboard capture and
 * clipboard behaviour.  Persisted per browser, applied live.
 */
export function TerminalSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TerminalSettings>(getTerminalSettings());
  const { theme, setTheme } = useTheme();
  const [editorOpen, setEditorOpen] = useState(false);
  const [themeDraft, setThemeDraft] = useState("");
  const [themeError, setThemeError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(getTerminalSettings());
      setThemeDraft(customThemeDraft());
      setThemeError(null);
      setEditorOpen(false);
    }
  }, [open]);

  const update = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const reset = () => setDraft({ ...DEFAULT_TERMINAL_SETTINGS });

  const saveTerminal = () => updateTerminalSettings(draft);

  const applyCustomTheme = () => {
    const parsed = parseCustomTheme(themeDraft);
    if (!parsed.spec || parsed.error) {
      setThemeError(parsed.error ?? "invalid theme");
      return;
    }
    saveCustomTheme(parsed.spec);
    setTheme("custom");
    setThemeError(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Settings (theme, terminal, keys, clipboard)">
          <Settings className="h-3.5 w-3.5" /> Settings
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[88vh] overflow-y-auto"
        title="Settings"
        description="Theme, terminal appearance and keyboard behaviour; stored in this browser."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">Appearance</p>
            <div className="flex items-center gap-3">
              <Label htmlFor="theme-select">Theme</Label>
              <Select
                id="theme-select"
                value={theme}
                className="h-8 w-44 text-xs"
                onChange={(event) => setTheme(event.target.value as typeof theme)}
              >
                {THEMES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
              <span className="text-[11px] text-zinc-500">{THEME_HINTS[theme] ?? ""}</span>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 self-start text-[11px] text-zinc-400 hover:text-zinc-100"
              onClick={() => setEditorOpen((value) => !value)}
            >
              {editorOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Edit custom theme (JSON)
            </button>
            {editorOpen ? (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] text-zinc-500">
                  Merged over the dark baseline — omit anything you do not override. `vars` holds CSS custom
                  properties (Tailwind palette: --color-zinc-*, --color-emerald-*, radii, shadows); `term` is
                  the xterm palette.
                </p>
                <textarea
                  value={themeDraft}
                  onChange={(event) => setThemeDraft(event.target.value)}
                  spellCheck={false}
                  className="h-48 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
                />
                {themeError ? <p className="text-xs text-red-400">{themeError}</p> : null}
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="secondary" onClick={applyCustomTheme}>
                    <Save className="h-3.5 w-3.5" /> Save & apply custom
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">Terminal</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Font size" hint="8–72">
                <Input
                  type="number"
                  min={8}
                  max={72}
                  value={draft.fontSize}
                  onChange={(event) => update("fontSize", Number(event.target.value))}
                />
              </Field>
              <Field label="Scrollback" hint="1–200000 lines">
                <Input
                  type="number"
                  min={1}
                  max={200000}
                  value={draft.scrollback}
                  onChange={(event) => update("scrollback", Number(event.target.value))}
                />
              </Field>
            </div>
            <Field label="Font family" hint="CSS font stack; monospace fallback is appended by the browser">
              <Input
                value={draft.fontFamily}
                className="font-mono text-xs"
                onChange={(event) => update("fontFamily", event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={draft.cursorBlink} onCheckedChange={(value) => update("cursorBlink", value)} />
              Blinking cursor
            </label>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">Keyboard capture</p>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={draft.captureEscape} onCheckedChange={(value) => update("captureEscape", value)} />
              Capture Escape — fixes vi Escape being swallowed by the browser
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={draft.captureCtrlB} onCheckedChange={(value) => update("captureCtrlB", value)} />
              Capture Ctrl+B — tmux prefix
            </label>
            <Field label="Custom capture keys" hint="comma-separated, e.g. F11, Ctrl+T, Alt+D">
              <Input
                value={draft.customCaptureKeys}
                className="font-mono text-xs"
                placeholder="F11, Ctrl+T, Alt+D"
                onChange={(event) => update("customCaptureKeys", event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch
                checked={draft.shiftEnterNewline}
                onCheckedChange={(value) => update("shiftEnterNewline", value)}
              />
              Shift+Enter sends ESC+CR — newline instead of submit in TUIs (Claude Code)
            </label>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">Clipboard</p>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch checked={draft.autoCopy} onCheckedChange={(value) => update("autoCopy", value)} />
              Auto-copy on selection
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch
                checked={draft.middleClickPaste}
                onCheckedChange={(value) => update("middleClickPaste", value)}
              />
              Middle-click paste
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <Switch
                checked={draft.clipboardShortcuts}
                onCheckedChange={(value) => update("clipboardShortcuts", value)}
              />
              Ctrl+Shift+C / Ctrl+Shift+V copy / paste
            </label>
          </div>

          <div className="flex items-center justify-between">
            <Button type="button" size="sm" variant="ghost" onClick={reset}>
              Reset terminal defaults
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  saveTerminal();
                  setOpen(false);
                }}
              >
                <Save className="h-4 w-4" /> Save terminal settings
              </Button>
            </div>
          </div>
          <Label className="text-[10px] text-zinc-600">
            Theme applies immediately; terminal font, scrollback and cursor changes apply live to open
            terminals on save.
          </Label>
        </div>
      </DialogContent>
    </Dialog>
  );
}

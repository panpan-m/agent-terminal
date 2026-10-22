import { useEffect, useState } from "react";
import { Save, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger, Switch } from "@/components/ui/dialog";
import { Field, Input, Label } from "@/components/ui/input";
import {
  DEFAULT_TERMINAL_SETTINGS,
  getTerminalSettings,
  updateTerminalSettings,
  type TerminalSettings,
} from "@/lib/terminal-settings";

/**
 * Terminal appearance and key/clipboard behaviour, persisted per browser and
 * applied live to every open terminal (serial and SSH).
 */
export function TerminalSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TerminalSettings>(getTerminalSettings());

  useEffect(() => {
    if (open) setDraft(getTerminalSettings());
  }, [open]);

  const update = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const reset = () => setDraft({ ...DEFAULT_TERMINAL_SETTINGS });

  const save = () => {
    updateTerminalSettings(draft);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="terminal settings (font, scrollback, keys, clipboard)">
          <Settings className="h-3.5 w-3.5" /> Settings
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Terminal settings"
        description="Applies live to every terminal (serial and SSH); stored in this browser."
      >
        <div className="flex flex-col gap-4">
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
              Reset to defaults
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={save}>
                <Save className="h-4 w-4" /> Save
              </Button>
            </div>
          </div>
          <Label className="text-[10px] text-zinc-600">
            Font, scrollback and cursor changes apply immediately to open terminals.
          </Label>
        </div>
      </DialogContent>
    </Dialog>
  );
}

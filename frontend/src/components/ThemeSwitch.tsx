import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { customThemeDraft, saveCustomTheme, THEMES, useTheme, type Theme } from "@/lib/theme";
import { parseCustomTheme } from "@/lib/themeSpecs";
import { cn } from "@/lib/utils";

const TITLES: Partial<Record<Theme, string>> = {
  pixel: "8-bit phosphor console",
  sheet: "paper engineering drawing",
  dark: "classic dark",
  light: "classic light",
  custom: "your JSON theme",
};

/** Theme picker plus a webssh2-style custom JSON theme editor. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div className={cn("theme-switch", className)} role="group" aria-label="Theme">
      {THEMES.map((item) => (
        <button
          key={item}
          type="button"
          title={TITLES[item] ?? "your JSON theme"}
          aria-pressed={theme === item}
          onClick={() => setTheme(item)}
        >
          {item}
        </button>
      ))}
      <CustomThemeDialog onSaved={() => setTheme("custom")} />
    </div>
  );
}

function CustomThemeDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(customThemeDraft());
      setError(null);
    }
  }, [open]);

  const apply = () => {
    setBusy(true);
    try {
      const parsed = parseCustomTheme(draft);
      if (!parsed.spec || parsed.error) {
        setError(parsed.error ?? "invalid theme");
        return;
      }
      saveCustomTheme(parsed.spec);
      onSaved();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" title="edit the custom JSON theme" className="px-1">
          <Pencil className="h-3 w-3" />
        </button>
      </DialogTrigger>
      <DialogContent
        className="w-[min(720px,94vw)]"
        title="Custom theme (JSON)"
        description="Merged over the dark baseline — omit anything you do not override. vars are CSS custom properties (Tailwind palette: --color-zinc-* , --color-emerald-*, radii, shadows); term is the xterm palette."
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          className="h-[55vh] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200 focus:border-emerald-500/60 focus:outline-none"
        />
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" disabled={busy} onClick={apply}>
            Save & apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

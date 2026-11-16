import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface ContextMenuEntry {
  key: string;
  label?: string;
  icon?: ReactNode;
  hint?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** red text for destructive actions (delete, close) */
  danger?: boolean;
  /** render a separator rule instead of an item */
  separator?: boolean;
  /** custom inline content row (e.g. a color palette) instead of a normal item */
  content?: ReactNode;
}

/**
 * Lightweight right-click menu: portal-rendered, viewport-clamped, closes on
 * outside pointer-down / Escape / scroll.  Marked `role="menu"` so
 * `isModalOpen()` keeps terminal shortcuts away while it is open.
 */
export function ContextMenu({
  x,
  y,
  entries,
  onClose,
  width = 220,
}: {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // clamp into the viewport once the real size is known
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nextX = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const nextY = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    setPos({ x: nextX, y: nextY });
  }, [x, y, entries]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onWheel = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-state="open"
      style={{ left: pos.x, top: pos.y, width }}
      className="fixed z-50 rounded-md border border-zinc-700/90 bg-zinc-900/95 py-1 text-[12px] text-zinc-200 shadow-2xl backdrop-blur"
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry) =>
        entry.separator ? (
          <div key={entry.key} className="my-1 h-px bg-zinc-700/70" />
        ) : entry.content !== undefined ? (
          <div key={entry.key} className="px-2 py-1">
            {entry.content}
          </div>
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect?.();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
              entry.disabled
                ? "cursor-default text-zinc-600"
                : entry.danger
                  ? "text-red-300 hover:bg-red-500/15"
                  : "hover:bg-zinc-700/70 hover:text-zinc-50",
            )}
          >
            {entry.icon ? <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{entry.icon}</span> : null}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint ? <span className="shrink-0 text-[10px] text-zinc-500">{entry.hint}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

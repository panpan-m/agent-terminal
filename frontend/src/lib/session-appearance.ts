/** Per-session UI accents (tab color, pin state) persisted in localStorage. */

const KEY = "tio.session-appearance.v1";

export interface SessionAppearance {
  color: string | null;
  pinned: boolean;
}

export const SESSION_COLORS = [
  "#34d399", // emerald
  "#38bdf8", // sky
  "#22d3ee", // cyan
  "#a3e635", // lime
  "#fbbf24", // amber
  "#fb923c", // orange
  "#fb7185", // rose
  "#a78bfa", // violet
] as const;

type Store = Record<string, SessionAppearance>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota — appearance just won't persist */
  }
}

export function loadAppearances(): Store {
  return read();
}

export function patchAppearance(id: string, patch: Partial<SessionAppearance>): Store {
  const store = read();
  const current: SessionAppearance = store[id] ?? { color: null, pinned: false };
  const next = { ...current, ...patch };
  if (next.color === null && !next.pinned) delete store[id];
  else store[id] = next;
  write(store);
  return store;
}

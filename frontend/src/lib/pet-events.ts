/**
 * Terminal pet event bus: the terminal pages feed raw signals in (keystrokes,
 * output bytes, link changes, command exits) and the pet component subscribes.
 * Follows the terminal-settings listener pattern; no DOM, safe to import
 * anywhere.
 */

export type PetOutputLevel = "stream" | "flood";

export type PetSignal =
  | { kind: "typing" }
  | { kind: "output"; level: PetOutputLevel }
  | { kind: "link"; up: boolean }
  | { kind: "command"; exitCode: number };

const OUTPUT_SAMPLE_MS = 600;
/** Ignore sampler ticks below this many bytes (echoes, single prompts). */
const OUTPUT_NOISE_BYTES = 512;
/** Above this many bytes per tick something is flooding the terminal. */
const OUTPUT_FLOOD_BYTES = 48 * 1024;
/** Collapse keystroke bursts into one typing signal. */
const TYPING_THROTTLE_MS = 150;

const listeners = new Set<(signal: PetSignal) => void>();

let lastSignalAt = 0;
let lastTypingAt = 0;
let lastLinkUp: boolean | null = null;
let pendingOutputBytes = 0;
let sampler: ReturnType<typeof setInterval> | null = null;

function emit(signal: PetSignal): void {
  lastSignalAt = Date.now();
  for (const listener of listeners) listener(signal);
}

function ensureSampler(): void {
  if (sampler !== null || typeof setInterval !== "function") return;
  sampler = setInterval(() => {
    const bytes = pendingOutputBytes;
    pendingOutputBytes = 0;
    if (bytes <= OUTPUT_NOISE_BYTES) return;
    const level: PetOutputLevel = bytes >= OUTPUT_FLOOD_BYTES ? "flood" : "stream";
    emit({ kind: "output", level });
  }, OUTPUT_SAMPLE_MS);
}

function stopSamplerIfIdle(): void {
  if (listeners.size === 0 && sampler !== null) {
    clearInterval(sampler);
    sampler = null;
    pendingOutputBytes = 0;
  }
}

/** User pressed a key in a terminal (throttled). */
export function petNoteTyping(): void {
  const now = Date.now();
  if (now - lastTypingAt < TYPING_THROTTLE_MS) return;
  lastTypingAt = now;
  emit({ kind: "typing" });
}

/** Terminal produced n bytes of output; level classification is sampled. */
export function petNoteOutput(n: number): void {
  pendingOutputBytes += Math.max(0, n);
}

/** Console link (serial or SSH websocket) went up or down. */
export function petNoteLink(up: boolean): void {
  if (lastLinkUp === up) return;
  lastLinkUp = up;
  emit({ kind: "link", up });
}

/** An agent-tracked command finished with the given exit code. */
export function petNoteCommandExit(exitCode: number | null): void {
  if (exitCode === null) return;
  emit({ kind: "command", exitCode });
}

/** Wall-clock ms since the last signal; drives the pet's idle → sleep. */
export function petLastActivityAt(): number {
  return lastSignalAt;
}

export function subscribePetSignals(listener: (signal: PetSignal) => void): () => void {
  listeners.add(listener);
  ensureSampler();
  return () => {
    listeners.delete(listener);
    stopSamplerIfIdle();
  };
}

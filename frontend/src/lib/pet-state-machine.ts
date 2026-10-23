/**
 * Pet behaviour state machine, after VPet's design: every state has a tier
 * (priority), a duration, and a fallback chain; higher tiers interrupt lower
 * ones immediately, equal tiers queue until the current one-shot finishes,
 * and alert states carry cooldowns so a busy terminal cannot lock the pet
 * into cheer/fall spam. Pure logic — the renderer maps states onto poses.
 */

import type { PetSignal } from "@/lib/pet-events";

export type PetStateId =
  | "idle"
  | "amble"
  | "work"
  | "watch"
  | "surprise"
  | "cheer"
  | "fall"
  | "sad"
  | "confused"
  | "greet"
  | "touch"
  | "jump"
  | "spin"
  | "wave"
  | "clap"
  | "drag"
  | "sleep";

export type PetInput =
  | PetSignal
  | { kind: "ui"; action: "touch" | "jump" | "spin" | "wave" | "drag-start" | "drag-end" | "bedtime" }
  /** Explicit user command from the pet's action panel: play this exact state. */
  | { kind: "ui"; action: "pose"; state: PetStateId };

interface PetStateDef {
  tier: 0 | 1 | 2 | 3;
  /** One-shot states fall through to `next`; sustain states refresh on repeat input. */
  durationMs: number;
  sustain?: boolean;
  next?: PetStateId;
  /** Alert states refuse to re-enter within this window. */
  cooldownMs?: number;
}

export const PET_STATES: Record<PetStateId, PetStateDef> = {
  idle: { tier: 0, durationMs: Infinity, sustain: true },
  amble: { tier: 0, durationMs: 2200, next: "idle" },
  work: { tier: 1, durationMs: 2600, sustain: true },
  watch: { tier: 1, durationMs: 3200, sustain: true },
  surprise: { tier: 1, durationMs: 1700, next: "idle", cooldownMs: 15_000 },
  cheer: { tier: 2, durationMs: 1800, next: "idle", cooldownMs: 8_000 },
  fall: { tier: 2, durationMs: 1100, next: "sad" },
  sad: { tier: 2, durationMs: 1500, next: "idle", cooldownMs: 8_000 },
  confused: { tier: 2, durationMs: 2400, next: "idle" },
  greet: { tier: 2, durationMs: 1500, next: "idle", cooldownMs: 6_000 },
  touch: { tier: 3, durationMs: 900, next: "idle" },
  jump: { tier: 3, durationMs: 950, next: "idle" },
  spin: { tier: 3, durationMs: 1200, next: "idle" },
  wave: { tier: 3, durationMs: 1500, next: "idle" },
  clap: { tier: 3, durationMs: 4767, next: "idle" },
  drag: { tier: 3, durationMs: Infinity, sustain: true },
  sleep: { tier: 0, durationMs: Infinity, sustain: true },
};

/** Milliseconds without any signal before the pet dozes off. */
export const PET_IDLE_SLEEP_MS = 5 * 60 * 1000;

const FALL_COOLDOWN_KEY: PetStateId = "sad";

export class PetStateMachine {
  private state: PetStateId = "idle";
  private enteredAt = 0;
  private pending: PetStateId | null = null;
  private lastAlertAt = new Map<PetStateId, number>();
  /** State picked from the action panel: hold it until another input arrives. */
  private manualHold: PetStateId | null = null;

  get current(): PetStateId {
    return this.state;
  }

  /** Force a state for debugging/verification (ignores tiers and cooldowns). */
  force(state: PetStateId, now: number): void {
    this.state = state;
    this.enteredAt = now;
    this.pending = null;
    this.manualHold = null;
  }

  /** Milliseconds the current state has been active. */
  elapsed(now: number): number {
    return now - this.enteredAt;
  }

  private enter(next: PetStateId, now: number): boolean {
    const def = PET_STATES[next];
    if (def.cooldownMs !== undefined) {
      const key = next === "fall" ? FALL_COOLDOWN_KEY : next;
      const last = this.lastAlertAt.get(key) ?? -Infinity;
      if (now - last < def.cooldownMs) return false;
      this.lastAlertAt.set(key, now);
    }
    this.state = next;
    this.enteredAt = now;
    return true;
  }

  private candidate(input: PetInput): PetStateId | null {
    switch (input.kind) {
      case "typing":
        return "work";
      case "output":
        return input.level === "flood" ? "surprise" : "watch";
      case "link":
        return input.up ? "greet" : "confused";
      case "command":
        return input.exitCode === 0 ? "cheer" : "fall";
      case "ui":
        switch (input.action) {
          case "touch":
            return "touch";
          case "jump":
            return "jump";
          case "spin":
            return "spin";
          case "wave":
            return "wave";
          case "drag-start":
            return "drag";
          case "drag-end":
            return null; // handled by tick fallback
          case "bedtime":
            return "sleep";
        }
        return null;
      default:
        return null;
    }
  }

  dispatch(input: PetInput, now: number): void {
    if (input.kind === "ui" && input.action === "drag-end") {
      this.manualHold = null;
      if (this.state === "drag") this.enter("idle", now);
      return;
    }
    if (input.kind === "ui" && input.action === "pose") {
      // User-picked pose overrides everything; one-shots replay from frame 0
      // and the state is held until the next input (panel debugging).
      this.state = input.state;
      this.enteredAt = now;
      this.pending = null;
      this.manualHold = input.state;
      return;
    }
    this.manualHold = null; // any live input takes control back from the panel
    const target = this.candidate(input);
    if (target === null) return;

    if (input.kind === "ui" && input.action === "bedtime") {
      this.enter("sleep", now); // always takes effect, never queued
      return;
    }

    if (this.state === "sleep" && target !== "sleep") {
      // any interesting input wakes the pet; the input itself may then apply
      this.enter("idle", now);
    }
    if (target === this.state) {
      if (PET_STATES[target].sustain) this.enteredAt = now; // refresh sustain window
      return;
    }
    // Reconnecting is the answer to being confused: greet immediately
    // instead of queueing behind the confused animation.
    if (this.state === "confused" && target === "greet") {
      this.enter(target, now);
      this.pending = null;
      return;
    }
    const targetTier = PET_STATES[target].tier;
    const currentTier = PET_STATES[this.state].tier;
    if (targetTier > currentTier || this.state === "sleep") {
      this.enter(target, now); // cooldown-refused alerts just leave state unchanged
      this.pending = null;
      return;
    }
    if (targetTier === currentTier) {
      this.pending = target; // wait for the current one-shot to finish
    }
    // lower tier: ignored; tick() falls back through `next` chains anyway
  }

  /** Advance time; returns the current state (caller reads .current / .elapsed). */
  tick(now: number, lastSignalAt: number): void {
    if (this.manualHold !== null && this.state === this.manualHold) return;
    const def = PET_STATES[this.state];
    // Finite durations apply to sustain states too: they are refreshed by
    // repeat input, and once that stops they fall back to `next`.
    if (this.elapsed(now) >= def.durationMs) {
      const next = this.pending ?? def.next ?? "idle";
      this.pending = null;
      this.enter(next === this.state ? "idle" : next, now);
      return;
    }
    // Idle stays perfectly still by design — no random ambient motion.
    if (this.state === "idle" && now - lastSignalAt > PET_IDLE_SLEEP_MS) {
      this.enter("sleep", now);
    }
  }
}

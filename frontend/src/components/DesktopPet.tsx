/**
 * The in-app desktop pet: ONE persistent 3D VRM model in the bottom-right
 * corner that performs every action in place (procedural bone motion, no
 * frame flipping). Terminal signals drive the pet state machine — typing
 * makes it run in place, command exits make it wave or fall over. Idle is
 * completely still. Rendering lives in PetScene; behaviour in
 * PetStateMachine; events in pet-events.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import defaultVrmUrl from "@/assets/pet/default.vrm";
import { subscribePetSignals, type PetSignal } from "@/lib/pet-events";
import { PetStateMachine, type PetInput, type PetStateId } from "@/lib/pet-state-machine";
import { PetScene, type PetFrame } from "@/lib/pet-model";
import { isLightTheme, useTheme } from "@/lib/theme";
import { getTerminalSettings, subscribeTerminalSettings, updateTerminalSettings } from "@/lib/terminal-settings";

const POSITION_KEY = "tio-pet-pos";
const MARGIN = 20;
/** Pointer travel (px) after which a press counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 6;

/** Every pose the pet can play, offered on the pet's action panel. */
const POSE_ACTIONS: { state: PetStateId; label: string }[] = [
  { state: "idle", label: "待机" },
  { state: "work", label: "原地跑" },
  { state: "watch", label: "注视" },
  { state: "surprise", label: "吃惊" },
  { state: "cheer", label: "欢呼" },
  { state: "fall", label: "摔倒" },
  { state: "sad", label: "难过" },
  { state: "confused", label: "疑惑" },
  { state: "greet", label: "打招呼" },
  { state: "wave", label: "挥手" },
  { state: "clap", label: "鼓掌" },
  { state: "touch", label: "被摸头" },
  { state: "jump", label: "跳一下" },
  { state: "spin", label: "转圈" },
  { state: "amble", label: "闲逛" },
  { state: "sleep", label: "睡觉" },
];

interface PetPosition {
  left: number;
  top: number;
}

function clampPosition(pos: PetPosition, width: number, height: number): PetPosition {
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return { left: Math.min(maxX, Math.max(MARGIN, pos.left)), top: Math.min(maxY, Math.max(MARGIN, pos.top)) };
}

function loadPosition(width: number, height: number): PetPosition {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) throw new Error("no stored position");
    const parsed = JSON.parse(raw) as Partial<PetPosition>;
    if (typeof parsed.left !== "number" || typeof parsed.top !== "number") throw new Error("bad position");
    return clampPosition({ left: parsed.left, top: parsed.top }, width, height);
  } catch {
    return clampPosition(
      { left: window.innerWidth - width - MARGIN, top: window.innerHeight - height - MARGIN },
      width,
      height,
    );
  }
}

function modelUrlFor(modelId: string): string {
  return modelId && modelId !== "builtin"
    ? `/api/pet/models/${encodeURIComponent(modelId)}/file`
    : defaultVrmUrl;
}

/** Ask the pet to snap back to its default corner (settings button). */
export function resetPetPosition(): void {
  try {
    window.localStorage.removeItem(POSITION_KEY);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event("tio-pet-reset-position"));
}

export function DesktopPet({ onNotice }: { onNotice?: (message: string, tone?: "info" | "error" | "success") => void }) {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<PetScene | null>(null);
  const machineRef = useRef(new PetStateMachine());
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastActivityRef = useRef(performance.now());
  const dragRef = useRef<{ startX: number; startY: number; originLeft: number; originTop: number; moved: boolean } | null>(null);

  const [settings, setSettings] = useState(getTerminalSettings);
  const [modelAspect, setModelAspect] = useState(1);
  const [position, setPosition] = useState<PetPosition>(() => loadPosition(getTerminalSettings().petSize, getTerminalSettings().petSize));
  const [state, setState] = useState<PetStateId>("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  /** Canvas height from settings; width follows the model's proportions. */
  const petHeight = settings.petSize;
  const petWidth = Math.min(480, Math.max(96, Math.round(petHeight * modelAspect)));

  const dimsRef = useRef({ w: petWidth, h: petHeight });
  dimsRef.current = { w: petWidth, h: petHeight };
  const positionRef = useRef(position);
  positionRef.current = position;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => subscribeTerminalSettings(() => setSettings(getTerminalSettings())), []);

  useEffect(() => {
    sceneRef.current?.resize(petWidth, petHeight);
    setPosition((pos) => clampPosition(pos, petWidth, petHeight));
  }, [petWidth, petHeight]);

  useEffect(() => {
    const onResize = () => setPosition((pos) => clampPosition(pos, dimsRef.current.w, dimsRef.current.h));
    const onReset = () =>
      setPosition(
        clampPosition({ left: Number.MAX_SAFE_INTEGER, top: Number.MAX_SAFE_INTEGER }, dimsRef.current.w, dimsRef.current.h),
      );
    window.addEventListener("resize", onResize);
    window.addEventListener("tio-pet-reset-position", onReset);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("tio-pet-reset-position", onReset);
    };
  }, []);

  // Scene + render loop lifecycle (StrictMode-safe: full teardown on cleanup).
  useEffect(() => {
    if (!settings.petEnabled) {
      setSceneReady(false);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new PetScene(canvas);
    sceneRef.current = scene;
    scene.resize(dimsRef.current.w, dimsRef.current.h);
    scene.setLightTheme(isLightTheme(theme));
    setSceneReady(true);
    setModelError(null);

    let frame = 0;
    const loop = () => {
      const now = performance.now();
      const machine = machineRef.current;
      machine.tick(now, lastActivityRef.current);
      if (machine.current !== stateRef.current) {
        stateRef.current = machine.current;
        setState(machine.current);
      }
      const frameInput: PetFrame = {
        state: machine.current,
        stateElapsedMs: machine.elapsed(now),
        nowMs: now,
        pointer: pointerRef.current,
      };
      scene.render(frameInput);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Debug hook: drive poses without rAF (works in throttled webviews).
    (window as unknown as Record<string, unknown>).__petDebug = {
      scene,
      machine: machineRef.current,
      info: () => scene.debugInfo(),
      setState: (id: PetStateId) => {
        machineRef.current.force(id, performance.now());
        stateRef.current = id;
        setState(id);
      },
      renderFrames: (count = 8, stepMs = 120) => {
        const start = performance.now();
        for (let i = 0; i < count; i += 1) {
          scene.render({
            state: machineRef.current.current,
            stateElapsedMs: i * stepMs,
            nowMs: start + i * stepMs,
            pointer: null,
          });
        }
      },
    };

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      delete (window as unknown as Record<string, unknown>).__petDebug;
      scene.dispose();
      sceneRef.current = null;
      setSceneReady(false);
    };
  }, [settings.petEnabled, theme]);

  // Model loading: builtin asset or an uploaded model, falling back to builtin.
  useEffect(() => {
    if (!settings.petEnabled || !sceneReady) return;
    let cancelled = false;
    const url = modelUrlFor(settings.petModelId);
    setModelError(null);
    sceneRef.current
      ?.loadModel(url)
      .then(() => {
        if (cancelled || !sceneRef.current) return;
        setModelAspect(sceneRef.current.aspect);
      })
      .catch(async (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (url !== defaultVrmUrl) {
          setModelError(`模型加载失败:${message};已切回内置模型`);
          await sceneRef.current
            ?.loadModel(defaultVrmUrl)
            .then(() => {
              if (!cancelled && sceneRef.current) setModelAspect(sceneRef.current.aspect);
            })
            .catch(() => undefined);
          onNotice?.("桌宠模型加载失败,已切回内置模型", "error");
        } else {
          setModelError(`模型加载失败:${message}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.petEnabled, settings.petModelId, sceneReady, onNotice]);

  useEffect(() => {
    sceneRef.current?.setLightTheme(isLightTheme(theme));
  }, [theme]);

  // Terminal signals drive the state machine.
  useEffect(
    () =>
      subscribePetSignals((signal: PetSignal) => {
        lastActivityRef.current = performance.now();
        machineRef.current.dispatch(signal, performance.now());
      }),
    [],
  );

  const dispatchUi = useCallback((input: PetInput) => {
    lastActivityRef.current = performance.now();
    machineRef.current.dispatch(input, performance.now());
  }, []);

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) {
      machineRef.current.dispatch({ kind: "ui", action: "drag-end" }, performance.now());
      try {
        window.localStorage.setItem(
          POSITION_KEY,
          JSON.stringify(clampPosition(positionRef.current, dimsRef.current.w, dimsRef.current.h)),
        );
      } catch {
        /* private mode */
      }
    }
  };

  if (!settings.petEnabled) return null;

  return (
    <div
      className="fixed z-20 select-none"
      style={{ left: position.left, top: position.top, width: petWidth, height: petHeight }}
      onPointerDown={(event) => {
        try {
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        } catch {
          /* untrusted/synthetic pointers cannot be captured; drag still works */
        }
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          originLeft: rect.left,
          originTop: rect.top,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        pointerRef.current = {
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: ((event.clientY - rect.top) / rect.height) * 2 - 1,
        };
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          drag.moved = true;
          machineRef.current.dispatch({ kind: "ui", action: "drag-start" }, performance.now());
        }
        if (drag.moved) {
          // Position = grab-point rect + total pointer travel: exact 1:1.
          setPosition(
            clampPosition({ left: drag.originLeft + dx, top: drag.originTop + dy }, dimsRef.current.w, dimsRef.current.h),
          );
        }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        pointerRef.current = null;
      }}
      onClick={() => {
        if (dragRef.current?.moved) return;
        setMenuOpen((open) => !open);
        dispatchUi({ kind: "ui", action: "touch" });
      }}
      role="img"
      aria-label={`终端桌宠(当前状态:${state})`}
    >
      <canvas ref={canvasRef} className="h-full w-full cursor-grab active:cursor-grabbing" />

      {state === "sleep" ? (
        <span className="pointer-events-none absolute right-1 top-1 animate-pulse text-lg text-sky-300/90">Zzz</span>
      ) : null}

      {menuOpen ? (
        <div
          className="absolute bottom-full right-0 mb-2 w-52 rounded-lg border border-zinc-700 bg-zinc-900/95 p-2 shadow-xl"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">动作调试</span>
            <button
              type="button"
              title="收起面板"
              className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-100"
              onClick={() => setMenuOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {POSE_ACTIONS.map((pose) => (
              <button
                key={pose.state}
                type="button"
                className={`rounded px-1 py-1 text-[11px] ${
                  state === pose.state
                    ? "bg-emerald-600/70 text-white"
                    : "bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700/70"
                }`}
                onClick={() => dispatchUi({ kind: "ui", action: "pose", state: pose.state })}
              >
                {pose.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full"
            onClick={() => {
              setMenuOpen(false);
              updateTerminalSettings({ petEnabled: false });
              onNotice?.("桌宠已隐藏,可在 终端设置 → 桌宠 里重新开启", "info");
            }}
          >
            隐藏桌宠
          </Button>
        </div>
      ) : null}

      {modelError ? (
        <div
          className="absolute inset-x-0 bottom-0 truncate rounded bg-red-950/80 px-1 text-center text-[10px] text-red-200"
          title={modelError}
        >
          {modelError}
        </div>
      ) : null}
    </div>
  );
}

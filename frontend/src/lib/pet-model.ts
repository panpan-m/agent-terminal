/**
 * Pet rendering: a small three.js scene that loads a VRM avatar and drives
 * purely procedural poses from the pet state machine (running in place,
 * waving, falling over, ...). One persistent model performs every action in
 * place — no animation clips, no frame flipping. Idle is completely still
 * (no breathing, no blinking); VRM expression presets carry the mood when
 * the model provides them.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

import type { PetStateId } from "@/lib/pet-state-machine";
import { CLAP_ACTION } from "@/lib/pet-action-clap";

/** A retargeted keyframe action (from Mixamo clips). */
interface KeyframeAction {
  duration: number;
  bones: Record<string, { q: number[][] }>;
  hipsY: number[][];
}

const FOV_DEG = 30;
/** Vertical room so raised arms (cheer, jump) stay inside the canvas. */
const FRAME_PADDING_H = 1.18;
/** Horizontal room so sideways poses (wave, confused) stay inside the canvas. */
const FRAME_PADDING_W = 1.32;

type BoneName =
  | "hips"
  | "spine"
  | "chest"
  | "upperChest"
  | "neck"
  | "head"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg"
  | "leftLowerLeg"
  | "rightLowerLeg";

interface RestPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface PetFrame {
  state: PetStateId;
  stateElapsedMs: number;
  nowMs: number;
  /** Pointer over the pet canvas in [-1..1] local space, null when away. */
  pointer: { x: number; y: number } | null;
}

const TAU = Math.PI * 2;

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/** States where the head tracks the pointer instead of the pose. */
const LOOK_STATES = new Set<PetStateId>(["idle", "sleep"]);

export class PetScene {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 20);
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly fillLight = new THREE.HemisphereLight(0xffffff, 0x404050, 1.4);
  private readonly lookTarget = new THREE.Object3D();
  private readonly lookNeutral = new THREE.Vector3();
  private vrm: VRM | null = null;
  private bones = new Map<BoneName, THREE.Object3D | null>();
  private rest = new Map<THREE.Object3D, RestPose>();
  private modelHeight = 1.55;
  private modelWidth = 0.55;
  private frameCenterY = 0.78;
  private canvasW = 168;
  private canvasH = 168;
  private nextBlinkAt = 0;
  private blinkPhaseStart = -1;
  private mood = new Map<string, number>();
  /** Lowercased expression name -> actual name on this model. */
  private expressionNames = new Map<string, string>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.keyLight.position.set(1.4, 2.2, 2.4);
    this.scene.add(this.keyLight, this.fillLight, this.lookTarget);
  }

  get modelReady(): boolean {
    return this.vrm !== null;
  }

  /** Display aspect ratio of the framed model (width / height). */
  get aspect(): number {
    return this.modelWidth / this.modelHeight;
  }

  async loadModel(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("file is not a VRM model");
    this.adoptModel(vrm);
  }

  private adoptModel(vrm: VRM): void {
    this.disposeModel();
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    // VRM 0.x models face -Z, opposite of VRM 1.0.
    const meta = vrm.meta as { metaVersion?: string };
    if (meta?.metaVersion === "0") vrm.scene.rotation.y = Math.PI;
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });
    this.vrm = vrm;
    this.scene.add(vrm.scene);

    this.bones = new Map();
    this.rest = new Map();
    for (const name of [
      "hips",
      "spine",
      "chest",
      "upperChest",
      "neck",
      "head",
      "leftUpperArm",
      "rightUpperArm",
      "leftLowerArm",
      "rightLowerArm",
      "leftHand",
      "rightHand",
      "leftUpperLeg",
      "rightUpperLeg",
      "leftLowerLeg",
      "rightLowerLeg",
    ] as BoneName[]) {
      const bone = vrm.humanoid?.getNormalizedBoneNode?.(name) ?? null;
      this.bones.set(name, bone);
      if (bone) this.rest.set(bone, { position: bone.position.clone(), quaternion: bone.quaternion.clone() });
    }

    // Measure the display box in the relaxed stance, not the T-pose rest:
    // the T-pose arm span would make the canvas far wider than needed.
    this.relaxArms();
    this.vrm.humanoid?.update();
    this.vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    this.modelHeight = Math.max(0.4, box.max.y - box.min.y);
    this.modelWidth = Math.max(0.2, box.max.x - box.min.x);
    this.frameCenterY = (box.max.y + box.min.y) / 2;

    const manager = vrm.expressionManager as unknown as { expressionMap?: Record<string, unknown> } | undefined;
    this.expressionNames = new Map(
      Object.keys(manager?.expressionMap ?? {}).map((name) => [name.toLowerCase(), name]),
    );

    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
    this.applyCamera();
  }

  /** Arms hang at the sides: VRM normalized rigs rest in a T-pose. */
  private relaxArms(): void {
    this.rotate(this.bone("leftUpperArm"), 0.08, 0, 1.15);
    this.rotate(this.bone("rightUpperArm"), 0.08, 0, -1.15);
    this.rotate(this.bone("leftLowerArm"), 0, 0, 0.18);
    this.rotate(this.bone("rightLowerArm"), 0, 0, -0.18);
  }

  /** Frame the whole model: camera distance fits both width and height. */
  private applyCamera(): void {
    const halfH = (this.modelHeight * FRAME_PADDING_H) / 2;
    const halfW = (this.modelWidth * FRAME_PADDING_W) / 2;
    const vTan = Math.tan((FOV_DEG * Math.PI) / 360);
    const aspect = this.canvasW / this.canvasH;
    const distance = Math.max(halfH / vTan, halfW / (vTan * aspect));
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, this.frameCenterY, distance);
    this.camera.lookAt(0, this.frameCenterY, 0);
    this.lookNeutral.set(0, this.frameCenterY + this.modelHeight * 0.04, distance);
  }

  setLightTheme(light: boolean): void {
    this.keyLight.intensity = light ? 2.6 : 2.2;
    this.fillLight.intensity = light ? 1.8 : 1.3;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.canvasW = Math.max(1, cssWidth);
    this.canvasH = Math.max(1, cssHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.canvasW, this.canvasH, false);
    this.applyCamera();
  }

  private bone(name: BoneName): THREE.Object3D | null {
    return this.bones.get(name) ?? null;
  }

  private rotate(bone: THREE.Object3D | null, x = 0, y = 0, z = 0): void {
    if (!bone) return;
    const restPose = this.rest.get(bone);
    if (!restPose) return;
    const euler = new THREE.Euler(x, y, z);
    bone.quaternion.copy(restPose.quaternion).multiply(new THREE.Quaternion().setFromEuler(euler));
  }

  private shift(bone: THREE.Object3D | null, dy: number, dz = 0): void {
    if (!bone) return;
    const restPose = this.rest.get(bone);
    if (!restPose) return;
    bone.position.copy(restPose.position);
    bone.position.y += dy;
    bone.position.z += dz;
  }

  private setExpression(name: string, weight: number): void {
    const manager = this.vrm?.expressionManager;
    if (!manager) return;
    const actual = this.expressionNames.get(name.toLowerCase());
    if (!actual) return; // model does not ship this preset
    try {
      manager.setValue(actual, weight);
    } catch {
      /* ignore setter failures */
    }
  }

  private updateMood(frame: PetFrame): void {
    const target: Record<string, number> = {
      happy:
        frame.state === "cheer" || frame.state === "greet" || frame.state === "wave" || frame.state === "clap"
          ? 1
          : 0,
      sad: frame.state === "sad" || frame.state === "sleep" ? (frame.state === "sad" ? 1 : 0.25) : 0,
      surprised: frame.state === "surprise" ? 1 : 0,
      relaxed: frame.state === "sleep" ? 1 : 0,
    };
    for (const [name, goal] of Object.entries(target)) {
      const current = this.mood.get(name) ?? 0;
      const next = current + (goal - current) * 0.12;
      this.mood.set(name, next);
      this.setExpression(name, next);
    }
  }

  private updateBlink(nowMs: number, state: PetStateId): void {
    // Resting states stay perfectly still; blinking only livens actions.
    if (state === "sleep" || state === "idle") return;
    if (nowMs >= this.nextBlinkAt) {
      this.blinkPhaseStart = nowMs;
      this.nextBlinkAt = nowMs + 2000 + Math.random() * 4000;
    }
    const phase = (nowMs - this.blinkPhaseStart) / 160;
    const weight = phase >= 0 && phase <= 2 ? Math.sin(Math.min(phase, 1) * Math.PI) * (phase <= 1 ? 1 : Math.sin((2 - phase) * Math.PI)) : 0;
    this.setExpression("blink", Math.min(1, Math.max(0, weight)));
  }

  private updateLook(frame: PetFrame): void {
    const weight = LOOK_STATES.has(frame.state) && frame.pointer ? 1 : 0;
    const target = new THREE.Vector3().copy(this.lookNeutral);
    if (frame.pointer) {
      target.x += frame.pointer.x * 0.28;
      target.y -= frame.pointer.y * 0.16;
    }
    this.lookTarget.position.lerp(target, weight ? 0.25 : 0.12);
  }

  private applyPose(frame: PetFrame): void {
    for (const [bone, restPose] of this.rest) {
      bone.position.copy(restPose.position);
      bone.quaternion.copy(restPose.quaternion);
    }
    this.relaxArms();
    const t = frame.nowMs / 1000;
    const elapsedS = frame.stateElapsedMs / 1000;

    switch (frame.state) {
      case "idle":
      case "sleep": {
        // Perfectly still at rest; only sleep leans the head.
        if (frame.state === "sleep") {
          this.rotate(this.bone("head"), 0.32);
          this.rotate(this.bone("neck"), 0.1);
          this.shift(this.bone("hips"), 0, -0.04);
        }
        break;
      }
      case "amble": {
        const sway = Math.sin(t * 2.4);
        this.rotate(this.bone("hips"), 0, sway * 0.08);
        this.rotate(this.bone("head"), 0, sway * 0.35, sway * 0.05);
        this.shift(this.bone("hips"), Math.abs(sway) * 0.01);
        break;
      }
      case "work": {
        // A real in-place run: arms and legs swing in opposition, with a
        // light bounce — this is the "I am typing, the pet runs" motion.
        const stride = Math.sin(t * 8.5);
        const lift = Math.abs(Math.cos(t * 8.5));
        this.rotate(this.bone("chest"), 0.14);
        this.rotate(this.bone("neck"), 0.06);
        this.rotate(this.bone("head"), 0.1);
        this.rotate(this.bone("leftUpperArm"), -stride * 0.75, 0, 0.15);
        this.rotate(this.bone("rightUpperArm"), stride * 0.75, 0, -0.15);
        this.rotate(this.bone("leftLowerArm"), -0.7);
        this.rotate(this.bone("rightLowerArm"), -0.7);
        this.rotate(this.bone("leftUpperLeg"), -stride * 0.62);
        this.rotate(this.bone("rightUpperLeg"), stride * 0.62);
        this.rotate(this.bone("leftLowerLeg"), -Math.max(0, stride) * 0.95 - 0.12);
        this.rotate(this.bone("rightLowerLeg"), -Math.max(0, -stride) * 0.95 - 0.12);
        this.shift(this.bone("hips"), lift * 0.025);
        break;
      }
      case "watch": {
        this.rotate(this.bone("chest"), -0.05);
        this.rotate(this.bone("head"), -0.12, 0.3);
        this.rotate(this.bone("leftUpperArm"), 0.12, 0, -0.18);
        this.rotate(this.bone("rightUpperArm"), 0.12, 0, 0.18);
        break;
      }
      case "surprise": {
        const pop = Math.min(1, elapsedS / 0.18);
        const settle = easeOutCubic(pop);
        this.rotate(this.bone("chest"), -0.22 * settle);
        this.rotate(this.bone("head"), -0.3 * settle);
        this.rotate(this.bone("leftUpperArm"), -0.7 * settle, 0, -0.9 * settle);
        this.rotate(this.bone("rightUpperArm"), -0.7 * settle, 0, 0.9 * settle);
        this.shift(this.bone("hips"), 0.045 * settle, -0.05 * settle);
        break;
      }
      case "cheer": {
        const hops = Math.abs(Math.sin(elapsedS * TAU * 2.2));
        this.shift(this.bone("hips"), hops * 0.09);
        this.rotate(this.bone("leftUpperArm"), 0, 0, -2.35);
        this.rotate(this.bone("rightUpperArm"), 0, 0, 2.35);
        this.rotate(this.bone("leftLowerArm"), 0, 0, -0.35);
        this.rotate(this.bone("rightLowerArm"), 0, 0, 0.35);
        this.rotate(this.bone("head"), -0.15);
        break;
      }
      case "fall": {
        // Forward stumble sequence (0.3s trip → 0.3s topple → 0.5s collapse):
        // lean 15° then 45° then 75°, arms reach for balance then hang.
        const stumble = Math.min(1, elapsedS / 0.3);
        const topple = Math.min(1, Math.max(0, (elapsedS - 0.3) / 0.3));
        const collapse = easeOutCubic(Math.min(1, Math.max(0, (elapsedS - 0.6) / 0.5)));
        const lean = 0.26 * stumble + 0.45 * topple + 0.60 * collapse;
        this.rotate(this.bone("spine"), lean * 0.55);
        this.rotate(this.bone("chest"), lean * 0.45);
        // Head strains up while toppling, drops once collapsed.
        this.rotate(this.bone("head"), -0.22 * topple * (1 - collapse) + 0.5 * collapse);
        // Arms: staggered balance raise → forward reach → hang loose.
        const balance = stumble * (1 - topple * 0.6);
        const reach = topple * (1 - collapse);
        const leftArmX = -0.9 * balance + 0.95 * reach + 0.35 * collapse;
        const rightArmX = -0.7 * balance + 0.95 * reach + 0.35 * collapse;
        this.rotate(this.bone("leftUpperArm"), leftArmX, 0, -0.5 * balance - 0.15 * reach);
        this.rotate(this.bone("rightUpperArm"), rightArmX, 0, 0.5 * balance + 0.15 * reach);
        this.rotate(this.bone("leftLowerArm"), -0.25 * reach);
        this.rotate(this.bone("rightLowerArm"), -0.25 * reach);
        // Legs: one step forward, then wide stagger, then knees bend deep
        // while the hips sink and push back (body folds onto itself).
        this.rotate(this.bone("leftUpperLeg"), -0.45 * stumble - 0.35 * collapse);
        this.rotate(this.bone("rightUpperLeg"), 0.3 * topple + 0.5 * collapse);
        this.rotate(this.bone("leftLowerLeg"), -0.3 * topple - 0.7 * collapse);
        this.rotate(this.bone("rightLowerLeg"), -0.2 * topple - 0.9 * collapse);
        this.shift(this.bone("hips"), -0.28 * collapse, -0.12 * collapse);
        this.rotate(this.bone("hips"), 0.25 * collapse);
        break;
      }
      case "sad": {
        // Sitting on the ground, deflated (the sequence's final frame):
        // hips drop to floor level, legs stretch forward, head bows.
        const settle = easeOutCubic(Math.min(1, elapsedS / 0.5));
        this.shift(this.bone("hips"), -0.62 * settle);
        this.rotate(this.bone("hips"), -0.35 * settle);
        this.rotate(this.bone("spine"), 0.5 * settle);
        this.rotate(this.bone("chest"), 0.3 * settle);
        this.rotate(this.bone("head"), 0.55 * settle);
        this.rotate(this.bone("leftUpperArm"), 0.15 * settle, 0, -0.15 * settle);
        this.rotate(this.bone("rightUpperArm"), 0.15 * settle, 0, 0.15 * settle);
        this.rotate(this.bone("leftUpperLeg"), -1.5 * settle);
        this.rotate(this.bone("rightUpperLeg"), -1.42 * settle);
        this.rotate(this.bone("leftLowerLeg"), 0.1 * settle);
        this.rotate(this.bone("rightLowerLeg"), 0.1 * settle);
        break;
      }
      case "confused": {
        const tilt = Math.sin(Math.min(elapsedS / 0.3, 1) * (Math.PI / 2));
        this.rotate(this.bone("head"), 0.05, 0.12, 0.28 * tilt);
        this.rotate(this.bone("rightUpperArm"), -0.55 * tilt, 0, 1.05 * tilt);
        this.rotate(this.bone("rightLowerArm"), -1.1 * tilt, 0, 0.5 * tilt);
        this.rotate(this.bone("upperChest") ?? this.bone("chest"), 0, -0.06 * tilt);
        break;
      }
      case "greet":
      case "wave": {
        const wag = Math.sin(elapsedS * TAU * 2.6);
        const lift = easeOutCubic(Math.min(1, elapsedS / 0.25));
        this.rotate(this.bone("rightUpperArm"), 0, 0, (2.1 - wag * 0.15) * lift);
        this.rotate(this.bone("rightLowerArm"), 0, 0, (0.4 - wag * 0.55) * lift);
        this.rotate(this.bone("head"), -0.08, wag * 0.08);
        this.shift(this.bone("hips"), Math.abs(wag) * 0.012 * lift);
        break;
      }
      case "touch": {
        const bounce = Math.sin(Math.min(elapsedS / 0.5, 1) * Math.PI);
        this.rotate(this.bone("head"), -0.18 * bounce);
        this.rotate(this.bone("chest"), -0.08 * bounce);
        this.shift(this.bone("hips"), 0.02 * bounce);
        break;
      }
      case "jump": {
        const arc = Math.sin(Math.min(elapsedS / 0.95, 1) * Math.PI);
        this.shift(this.bone("hips"), arc * 0.16);
        this.rotate(this.bone("leftUpperArm"), 0, 0, -0.5 * arc);
        this.rotate(this.bone("rightUpperArm"), 0, 0, 0.5 * arc);
        break;
      }
      case "spin": {
        const turn = easeOutCubic(Math.min(elapsedS / 1.2, 1)) * TAU;
        this.rotate(this.bone("hips"), 0, turn);
        this.rotate(this.bone("leftUpperArm"), 0, 0, -0.9);
        this.rotate(this.bone("rightUpperArm"), 0, 0, 0.9);
        break;
      }
      case "clap": {
        this.applyKeyframes(CLAP_ACTION, elapsedS);
        break;
      }
      case "drag": {
        const swing = Math.sin(t * 9);
        this.rotate(this.bone("hips"), 0, 0, swing * 0.07);
        this.rotate(this.bone("leftUpperArm"), 0, 0, -0.55 - swing * 0.1);
        this.rotate(this.bone("rightUpperArm"), 0, 0, 0.55 + swing * 0.1);
        break;
      }
    }
  }

  /** Sample a retargeted keyframe action (loops over its duration). */
  private applyKeyframes(action: KeyframeAction, elapsedS: number): void {
    const t = elapsedS % action.duration;
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    const out = new THREE.Quaternion();
    for (const [name, track] of Object.entries(action.bones)) {
      const bone = this.bones.get(name as BoneName);
      if (!bone) continue;
      const keys = track.q;
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1][0] <= t) i += 1;
      const a = keys[i];
      const b = keys[i + 1] ?? a;
      const span = Math.max(1e-6, b[0] - a[0]);
      const k = Math.min(1, Math.max(0, (t - a[0]) / span));
      qa.set(a[1], a[2], a[3], a[4]);
      qb.set(b[1], b[2], b[3], b[4]);
      out.slerpQuaternions(qa, qb, k);
      bone.quaternion.copy(out);
    }
    const hips = this.bone("hips");
    const ys = action.hipsY;
    if (hips && ys.length > 0) {
      let i = 0;
      while (i < ys.length - 2 && ys[i + 1][0] <= t) i += 1;
      const a = ys[i];
      const b = ys[i + 1] ?? a;
      const k = Math.min(1, Math.max(0, (t - a[0]) / Math.max(1e-6, b[0] - a[0])));
      const restPose = this.rest.get(hips);
      if (restPose) {
        hips.position.copy(restPose.position);
        hips.position.y += a[1] + (b[1] - a[1]) * k;
      }
    }
  }

  render(frame: PetFrame): void {
    if (!this.vrm) return;
    this.updateMood(frame);
    this.updateBlink(frame.nowMs, frame.state);
    this.updateLook(frame);
    this.applyPose(frame);
    const delta = 1 / 60;
    this.vrm.humanoid?.update();
    this.vrm.update(delta);
    this.renderer.render(this.scene, this.camera);
  }

  /** Capability report for debugging: which bones, expressions and look-at exist. */
  debugInfo(): {
    bones: string[];
    expressions: string[];
    lookAt: boolean;
    springBones: number;
    meta: Record<string, unknown>;
  } {
    const vrm = this.vrm;
    if (!vrm) {
      return { bones: [], expressions: [], lookAt: false, springBones: 0, meta: {} };
    }
    const allBoneNames = [
      "hips", "spine", "chest", "upperChest", "neck", "head",
      "leftEye", "rightEye", "jaw",
      "leftShoulder", "rightShoulder",
      "leftUpperArm", "leftLowerArm", "leftHand",
      "rightUpperArm", "rightLowerArm", "rightHand",
      "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
      "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
    ];
    const bones = allBoneNames.filter(
      (name) => vrm.humanoid?.getNormalizedBoneNode?.(name as never) != null,
    );
    const manager = vrm.expressionManager as unknown as {
      _expressions?: { __name?: string }[];
      expressionMap?: Record<string, unknown>;
    };
    const expressionNames = Object.keys(manager?.expressionMap ?? {});
    const fallback = (manager?._expressions ?? []).map((item) => item.__name ?? "").filter(Boolean);
    return {
      bones,
      expressions: expressionNames.length > 0 ? expressionNames : fallback,
      lookAt: vrm.lookAt != null,
      springBones: vrm.springBoneManager?.joints?.size ?? 0,
      meta: { ...(vrm.meta as object) },
    };
  }

  disposeModel(): void {
    if (!this.vrm) return;
    const vrm = this.vrm;
    this.vrm = null;
    this.bones.clear();
    this.rest.clear();
    this.scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }

  dispose(): void {
    this.disposeModel();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

import type { AutomationPoint, EffectSpec } from "bruit-kit/audio";
import type { WaveformRange } from "bruit-kit/ui";

/** Wraps an arbitrary fraction into [0, 1) -- position motion (curve/wander)
 * can drift outside [0,1] before this normalizes it back onto the buffer,
 * same wraparound semantics as DirectionalSamplePlayer's own
 * startFraction/endFraction (see its module doc comment). */
export function wrapFraction(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** Forward-wrap distance from start to end, always in [0, 1) -- 0 only when
 * start and end are exactly equal. A plain `end - start` would go negative
 * for a wrapped range (end < start), which is exactly the case this
 * exists for: a node's range.start > range.end means "wraps through the
 * buffer's end back to its start," not an invalid ordering -- see
 * SampleNode.range's own doc comment. */
export function wrappedLength(start: number, end: number): number {
  return wrapFraction(end - start);
}

/** forward/backward always play the same way; alternating flips after
 * every fire, so ping-pong emerges across repeated fires (see the design
 * note in sampleNodeEngine.ts) rather than being a property of one fire. */
export type Direction = "forward" | "backward" | "alternating";

/** manual: each click, or each inbound graph edge targeting this node, is
 * one trigger. loop: while armed, the engine's scheduler generates a
 * trigger every triggerPeriodSeconds seconds. Disarming stops future
 * triggers but never cuts off fires already in flight. */
export type ArmMode = "manual" | "loop";

/** single: a trigger produces exactly one fire. curveSpaced: a trigger
 * produces `fireCount` fires, gapped according to `intervalCurve`. */
export type FiringPattern = "single" | "curveSpaced";

export type MotionMode = "none" | "curve" | "wander" | "both";

/** Config for one of a node's two independently-modulated live scalars
 * (position or length -- see MotionState below). `curvePoints`/
 * `curveDurationSeconds` apply when mode is "curve" or "both": elapsed
 * time, looped over curveDurationSeconds, maps through the curve into
 * [min, max]. `wanderSpeed` applies when mode is "wander" or "both":
 * bruit-kit's driftMath retarget-then-glide random walk, also remapped
 * into [min, max]. "both" sums the two contributions (each still
 * independently within [min,max] before summing, so the combined result
 * can exceed either alone -- deliberately, more range of motion is the
 * point of layering both). */
export interface MotionConfig {
  mode: MotionMode;
  curvePoints: AutomationPoint[];
  curveDurationSeconds: number;
  wanderSpeed: number;
  min: number;
  max: number;
}

export function createMotionConfig(min: number, max: number): MotionConfig {
  return {
    mode: "none",
    curvePoints: [
      { position: 0, value: 1 },
      { position: 0.3, value: 0.4 },
      { position: 0.6, value: 0.15 },
      { position: 1, value: 0.05 },
    ],
    curveDurationSeconds: 4,
    wanderSpeed: 0.5,
    min,
    max,
  };
}

/** A sample node's authored, static configuration -- its live state (which
 * way `alternating` fires next, its current moved range, in-flight
 * timers, armed/disarmed) lives in SampleNodeEngine, keyed by id, not
 * here. */
export interface SampleNode {
  id: string;
  label: string;
  color: string;
  /** 0..1 fractions of the loaded buffer's own duration -- the base range
   * range motion (below) moves away from and returns to being the default
   * when motion is "none". Directional, not an unordered {lo,hi} bound:
   * if start > end, the fragment wraps through the buffer's end back to
   * its start (see wrappedLength). */
  range: WaveformRange;
  direction: Direction;
  /** Tape-style: shifts pitch and speed together. */
  rateSemitones: number;
  /** Declick fade in/out applied at every fire's own start/end. */
  fadeMs: number;

  armMode: ArmMode;
  triggerPeriodSeconds: number;

  firingPattern: FiringPattern;
  fireCount: number;
  intervalCurve: AutomationPoint[];
  intervalMinMs: number;
  intervalMaxMs: number;

  positionMotion: MotionConfig;
  lengthMotion: MotionConfig;

  /** This node's own effect chain, applied to its voices before they join
   * the shared mix bus -- see SampleNodeEngine's per-node
   * DirectionalSamplePlayer + BuiltEffectsChain pair. */
  effects: EffectSpec[];

  /** Fires once per *trigger* (covers the whole firing burst, not each
   * individual fire) -- see SampleNodeEngine.trigger(). */
  modulationRoute: ModulationRoute;
}

/** "On trigger, ramp param X along a curve over durationSeconds" --
 * targeting one of this node's own chain effects' exposed AudioParams
 * (via BuiltEffectsChain.getAudioParam(targetEffectIndex,
 * targetParamKey); `bruit-kit`'s effect classes name theirs
 * `frequencyParam`, `rateParam`, `delayTimeParam`, etc., see each
 * effect's own source). `useModulator` is the brief's two-stage case ("an
 * LFO sweep that then modulates a chorus depth"): instead of ramping the
 * target directly, a `createTriggerableModulator` continuously modulates
 * the target, and the curve ramps the *modulator's own rate* instead
 * (`depthCurvePoints` ramps its depth the same way) -- see
 * SampleNodeEngine.trigger(). */
export interface ModulationRoute {
  enabled: boolean;
  targetEffectIndex: number;
  targetParamKey: string;
  useModulator: boolean;
  curvePoints: AutomationPoint[];
  durationSeconds: number;
  valueMin: number;
  valueMax: number;
  depthCurvePoints: AutomationPoint[];
  depthMin: number;
  depthMax: number;
}

export function createModulationRoute(): ModulationRoute {
  return {
    enabled: false,
    targetEffectIndex: 0,
    targetParamKey: "frequencyParam",
    useModulator: false,
    curvePoints: [
      { position: 0, value: 0 },
      { position: 1, value: 1 },
    ],
    durationSeconds: 1,
    valueMin: 200,
    valueMax: 4000,
    depthCurvePoints: [
      { position: 0, value: 0 },
      { position: 0.3, value: 1 },
      { position: 1, value: 0.2 },
    ],
    depthMin: 0,
    depthMax: 1000,
  };
}

let nextId = 1;

export function createSampleNode(color: string): SampleNode {
  const id = `node-${nextId++}`;
  return {
    id,
    label: id,
    color,
    range: { start: 0.1, end: 0.5 },
    direction: "forward",
    rateSemitones: 0,
    fadeMs: 4,

    armMode: "manual",
    triggerPeriodSeconds: 0.5,

    firingPattern: "single",
    fireCount: 6,
    intervalCurve: [
      { position: 0, value: 1 },
      { position: 0.5, value: 0.35 },
      { position: 1, value: 0.05 },
    ],
    intervalMinMs: 40,
    intervalMaxMs: 600,

    // Position motion's [min,max] is a fraction-of-buffer excursion range
    // for the range's start point; default off (mode: "none") until the
    // user opts in. Length motion's [min,max] is a fraction-of-buffer span
    // for the range's own width.
    positionMotion: createMotionConfig(0, 0.9),
    lengthMotion: createMotionConfig(0.02, 0.4),

    effects: [],
    modulationRoute: createModulationRoute(),
  };
}

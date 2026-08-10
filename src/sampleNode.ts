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

export type MotionMode = "none" | "fixed" | "curve" | "wander" | "both";

/** Config for one of a node's two independently-modulated live scalars
 * (position or duration -- see SampleNode.positionMotion/durationMotion).
 * `min`/`max` are
 * fractions local to the node's own selected range (SampleNode.range),
 * not the whole buffer -- the range is the candidate playback area, and
 * motion only ever moves within it (see SampleNodeEngine.rangeAtTime).
 * For position, 0 = the range's own start, 1 = its own end. For duration,
 * 0 = (clamped to) a sliver, 1 = the range's own full length. `fixedValue`
 * applies when mode is "fixed": a constant local value, unlike "none"
 * (whose fallback is baked into the caller -- range start for position,
 * full range length for duration) this is user-set and can be any value
 * in between, e.g. "always exactly 35% of the range's length" rather than
 * always 0% or always 100%. `curvePoints`/`curveDurationSeconds` apply
 * when mode is "curve" or "both": elapsed time, looped over
 * curveDurationSeconds, maps through the curve into [min, max].
 * `wanderSpeed` applies when mode is "wander" or "both": bruit-kit's
 * driftMath retarget-then-glide random walk, also remapped into
 * [min, max]. "both" sums the two contributions (each still independently
 * within [min,max] before summing, so the combined result can exceed
 * either alone -- deliberately, more range of motion is the point of
 * layering both). */
export interface MotionConfig {
  mode: MotionMode;
  fixedValue: number;
  curvePoints: AutomationPoint[];
  curveDurationSeconds: number;
  wanderSpeed: number;
  min: number;
  max: number;
}

export function createMotionConfig(
  min: number,
  max: number,
  curvePoints: AutomationPoint[] = [
    { position: 0, value: 1 },
    { position: 0.3, value: 0.4 },
    { position: 0.6, value: 0.15 },
    { position: 1, value: 0.05 },
  ],
  fixedValue = 1,
): MotionConfig {
  return {
    mode: "none",
    fixedValue,
    curvePoints,
    curveDurationSeconds: 4,
    wanderSpeed: 0.5,
    min,
    max,
  };
}

/** A plain two-point ramp from the curve's lowest output to its highest --
 * a fresh array per call (never a shared module-level constant), since
 * curvePoints is meant to be freely replaceable per node without any risk
 * of one node's edit reaching another's. */
function ascendingCurve(): AutomationPoint[] {
  return [
    { position: 0, value: 0 },
    { position: 1, value: 1 },
  ];
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
  /** How much of the candidate range actually plays on a given fire --
   * 0 = (clamped to) a sliver, 1 = the range's own full length. Governs a
   * single fire's playback duration directly (span / rate), evaluated at
   * each fire's own time same as positionMotion, so a repeatedly-triggered
   * single-fire node can "breathe" in duration too, not just position. */
  durationMotion: MotionConfig;

  /** This node's own effect chain, applied to its voices before they join
   * the shared mix bus -- see SampleNodeEngine's per-node
   * DirectionalSamplePlayer + BuiltEffectsChain pair. */
  effects: EffectSpec[];

  /** Fires once per *trigger* (covers the whole firing burst, not each
   * individual fire) -- see SampleNodeEngine.trigger(). Independent of
   * lfoRoute -- a node can use either, both, or neither, not a toggle
   * between them. */
  sweepRoute: SweepRoute;
  /** Same trigger timing as sweepRoute, but continuously modulates the
   * target via an oscillator instead of ramping it directly -- see
   * lfoRoute's own doc comment. */
  lfoRoute: LfoRoute;
}

/** -1 means "no effect selected" -- the default/empty state for a node
 * with no effects yet, or before the user has picked one. Never a valid
 * index into SampleNode.effects. */
export const NO_TARGET_EFFECT = -1;

/** "On trigger, ramp param X along a curve over the node's own
 * triggerPeriodSeconds" -- targeting one of this node's own chain
 * effects' exposed AudioParams (via BuiltEffectsChain.getAudioParam(
 * targetEffectIndex, targetParamKey), populated in the UI from
 * bruit-kit's getEffectParamOptions rather than typed in free-form).
 * No separate duration field: the ramp always follows the node's own
 * trigger period (loop mode's actual cadence, or just its configured
 * value for manual/graph-driven triggers) rather than an independently
 * tunable number that could drift out of sync with it -- see
 * SampleNodeEngine.trigger()/setNodeSweepRoute. */
export interface SweepRoute {
  enabled: boolean;
  targetEffectIndex: number;
  targetParamKey: string;
  curvePoints: AutomationPoint[];
  valueMin: number;
  valueMax: number;
}

export function createSweepRoute(): SweepRoute {
  return {
    enabled: false,
    targetEffectIndex: NO_TARGET_EFFECT,
    targetParamKey: "",
    curvePoints: [
      { position: 0, value: 0 },
      { position: 1, value: 1 },
    ],
    valueMin: 200,
    valueMax: 4000,
  };
}

/** The brief's two-stage case ("an LFO sweep that then modulates a chorus
 * depth"): rather than ramping the target directly, a
 * createTriggerableModulator continuously modulates it, and the curve
 * ramps the *modulator's own rate* instead (depthCurvePoints ramps its
 * depth the same way) -- see SampleNodeEngine.trigger()/
 * setNodeLfoRoute. */
export interface LfoRoute {
  enabled: boolean;
  targetEffectIndex: number;
  targetParamKey: string;
  curvePoints: AutomationPoint[];
  durationSeconds: number;
  valueMin: number;
  valueMax: number;
  depthCurvePoints: AutomationPoint[];
  depthMin: number;
  depthMax: number;
}

export function createLfoRoute(): LfoRoute {
  return {
    enabled: false,
    targetEffectIndex: NO_TARGET_EFFECT,
    targetParamKey: "",
    curvePoints: [
      { position: 0, value: 0 },
      { position: 1, value: 1 },
    ],
    durationSeconds: 1,
    valueMin: 1,
    valueMax: 20,
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
    fireCount: 10,
    intervalCurve: [
      { position: 0, value: 1 },
      { position: 0.5, value: 0.35 },
      { position: 1, value: 0.05 },
    ],
    intervalMinMs: 40,
    intervalMaxMs: 600,

    // Position motion's [min,max] is a fraction-of-range (not
    // fraction-of-buffer -- see MotionConfig's own doc comment) excursion
    // for the range's start point; default off (mode: "none") until the
    // user opts in. Duration motion's [min,max] is a fraction of the
    // range's own length -- clamped to a 0.01 floor regardless of this
    // config (see SampleNodeEngine.rangeAtTime) so it can never fully
    // silence a fire. Both default to a plain low-to-high ramp rather
    // than the generic decay shape -- a predictable sweep to opt into,
    // not a specific creative choice baked into the default.
    positionMotion: createMotionConfig(0, 1.0, ascendingCurve(), 0),
    durationMotion: createMotionConfig(0.01, 1.0, ascendingCurve(), 1),

    effects: [],
    sweepRoute: createSweepRoute(),
    lfoRoute: createLfoRoute(),
  };
}

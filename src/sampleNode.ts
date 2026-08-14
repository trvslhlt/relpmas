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

/** single: a trigger produces exactly one fire. fixedCount: a trigger
 * produces exactly `fireCount` fires, gapped according to
 * `intervalCurve` sampled by fire index and remapped into
 * [intervalMinMs, intervalMaxMs] -- the burst's own real span is
 * whatever that sums to, not directly set. fullTrigger: a trigger keeps
 * firing, for as long as the node's own triggerPeriodSeconds lasts, with
 * each gap read from the *same* intervalCurve but sampled by elapsed
 * time within the trigger instead of fire index -- the curve's shape
 * sweeps across real time over the course of the trigger (e.g. a
 * decaying curve makes firing accelerate as the trigger goes on).
 * randomTrigger: the same open-ended "for as long as the trigger lasts"
 * shape as fullTrigger, but each gap is drawn uniformly at random from
 * [intervalMinMs, intervalMaxMs] instead of following intervalCurve --
 * an unshaped, jittery machine-gun rather than a deliberately swept one.
 * See SampleNodeEngine.trigger()'s own doc comment for exactly how each
 * builds its fireTimes. */
export type FiringPattern =
  | "single"
  | "fixedCount"
  | "fullTrigger"
  | "randomTrigger";

/** Config for one of a node's three independently-modulated live scalars
 * (position, duration, or rate -- see SampleNode.positionMotion/
 * durationMotion/rateMotion). `min`/`max` are fractions local to the
 * node's own selected range (SampleNode.range) for position/duration, or
 * a plain multiplier range for rate -- see each field's own doc comment.
 * The range is the candidate playback area for position/duration, and
 * motion only ever moves within it (see SampleNodeEngine.rangeAtTime).
 *
 * `useFixed` is exclusive: when true, the result is always exactly
 * `fixedValue`, ignoring every other field below -- a constant has
 * nothing meaningful to combine with a sweep. When false, every other
 * enabled toggle contributes and their values sum (see
 * SampleNodeEngine.evaluateMotion) -- "more range of motion is the point
 * of layering," the same principle a single "both" mode used to express
 * for exactly two contributions (curve + wander), now generalized to any
 * combination. Named around this project's own arm -> trigger -> fire
 * vocabulary (see the PLAN's "Core model"): a trigger starts a node's
 * cycle, a fire is one actual sample playback within it.
 *
 * - `duringTriggerEnabled`: samples `curvePoints` at (time elapsed since
 *   the node's own *last trigger*) / triggerPeriodSeconds -- restarts at
 *   curve position 0 on every trigger (manual, loop, or graph-cascaded
 *   alike) and completes exactly as the next one is due, same
 *   trigger-relative timing sweepRoute/lfoRoute's own ramps use. For
 *   something evaluated only once per fire (rate, duration), this is
 *   only actually visible across a multi-fire burst spread out over
 *   real time -- a single fire happens at essentially the trigger's own
 *   start, so elapsed time there is always ~0 (see fireEnabled below and
 *   acrossTriggersEnabled for the two ways to get real movement out of a
 *   single-fire node instead).
 * - `fireEnabled`: samples `curvePoints` at this specific fire's own
 *   position within the current firing burst (0 for a single fire, or
 *   the first of a multi-fire burst; 1 for the burst's last fire) --
 *   baked into that one voice at the instant it fires, never
 *   re-evaluated during its own playback. Same "always ~0 for a single
 *   fire" caveat as duringTriggerEnabled, for the same reason (a single
 *   fire has no burst to have a position within).
 * - `acrossTriggersEnabled`: samples `curvePoints` at (a persistent count
 *   of how many triggers this node has had so far, wrapped modulo
 *   `triggerCycleLength`) / `triggerCycleLength` -- advances exactly one
 *   step *per trigger event*, not per unit of elapsed time, so it stays
 *   in sync with the pattern's own cadence even if that cadence isn't
 *   steady (manual clicks, a tempo change, graph-cascaded triggers of
 *   varying gaps). This is what makes a single-fire node's value
 *   actually move from one trigger to the next, unlike
 *   duringTriggerEnabled/fireEnabled above.
 * - `continuousEnabled`: samples `curvePoints` against a free-running
 *   clock, looped over its own `continuousLoopSeconds`, entirely
 *   independent of triggers or fires -- never resets, keeps looping
 *   whether or not anything is actually playing.
 * - `useWander`: bruit-kit's driftMath retarget-then-glide random walk,
 *   at `wanderSpeed`, continuous and trigger-independent like
 *   `continuousEnabled` but random rather than a drawn shape.
 *
 * The four curve-based toggles share one `curvePoints` shape (checking
 * more than one samples the *same* curve several different ways, rather
 * than needing separately-drawn curves) -- only shown in the UI once at
 * least one of them is checked (see nodeMenu.ts's motionFields).
 * `fallback` is when nothing is enabled at all: baked into the caller,
 * not stored here (range start for position, full range length for
 * duration -- see rangeAtTime). */
export interface MotionConfig {
  useFixed: boolean;
  fixedValue: number;

  curvePoints: AutomationPoint[];
  duringTriggerEnabled: boolean;
  fireEnabled: boolean;
  acrossTriggersEnabled: boolean;
  /** Only meaningful while acrossTriggersEnabled -- how many triggers one
   * full lap of the curve spans before wrapping back to position 0. */
  triggerCycleLength: number;
  continuousEnabled: boolean;
  /** Only meaningful while continuousEnabled -- independent of
   * triggerPeriodSeconds on purpose (see continuousEnabled's own doc
   * comment: the whole point is *not* tracking the trigger's own
   * cadence). */
  continuousLoopSeconds: number;

  useWander: boolean;
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
    useFixed: false,
    fixedValue,
    curvePoints,
    duringTriggerEnabled: false,
    fireEnabled: false,
    acrossTriggersEnabled: false,
    triggerCycleLength: 8,
    continuousEnabled: false,
    continuousLoopSeconds: 4,
    useWander: false,
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

/** Default rateMotion: fixed at 1.0 (normal speed/pitch, tape-style --
 * shifts together), in a plausible [0.1, 5] multiplier range for when a
 * curve toggle is switched on -- unlike positionMotion/durationMotion,
 * "nothing enabled" isn't a meaningful default here (there's no separate
 * not-moving fallback distinct from "fixed at 1.0"), so this starts with
 * useFixed already on rather than createMotionConfig's own all-off
 * default. fireEnabled is the natural first toggle to reach for once
 * fixed is turned off for a multi-fire node (sweeping rate across a
 * burst); acrossTriggersEnabled is the one for a single-fire node
 * (stepping rate from one trigger to the next) -- see MotionConfig's own
 * doc comment on both. Everything still starts off same as every other
 * toggle; nothing here restricts which the user can actually check. */
function createRateMotion(): MotionConfig {
  return {
    useFixed: true,
    fixedValue: 1,
    curvePoints: ascendingCurve(),
    duringTriggerEnabled: false,
    fireEnabled: false,
    acrossTriggersEnabled: false,
    triggerCycleLength: 8,
    continuousEnabled: false,
    continuousLoopSeconds: 4,
    useWander: false,
    wanderSpeed: 0.5,
    min: 0.1,
    max: 5,
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
   * when nothing in positionMotion is enabled. Directional, not an
   * unordered {lo,hi} bound: if start > end, the fragment wraps through
   * the buffer's end back to its start (see wrappedLength). */
  range: WaveformRange;
  direction: Direction;
  /** Tape-style playback rate multiplier (1.0 = normal; shifts pitch and
   * speed together) -- see MotionConfig's own doc comment for the five
   * ways it can move (during a trigger, per fire, across triggers,
   * continuously, or random wander, any combination at once). Defaults
   * to a plain fixed 1.0 (see createRateMotion). */
  rateMotion: MotionConfig;
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
   * 0 = (clamped to) a sliver, 1 = the range's own full length. See
   * MotionConfig's own doc comment for the four ways it can move; a
   * repeatedly-triggered node can "breathe" in duration, not just
   * position, once any of them is enabled. */
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
 * setNodeLfoRoute. No separate duration field, same reasoning as
 * SweepRoute's own doc comment: both ramps always span the node's own
 * triggerPeriodSeconds rather than an independently tunable number. */
export interface LfoRoute {
  enabled: boolean;
  targetEffectIndex: number;
  targetParamKey: string;
  curvePoints: AutomationPoint[];
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
    rateMotion: createRateMotion(),
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
    // for the range's start point. Duration motion's [min,max] is a
    // fraction of the range's own length -- clamped to a 0.01 floor
    // regardless of this config (see SampleNodeEngine.rangeAtTime) so it
    // can never fully silence a fire. Both default to fixed (0 = the
    // range's own start for position, 1.0 = the range's own full length
    // for duration, same as rateMotion's own fixed-1.0 default) rather
    // than createMotionConfig's own all-toggles-off default --
    // functionally identical (both fall back to the same values when
    // nothing's enabled), but shows a fresh node's Position/Duration
    // sections as "use fixed value" checked with that value visible,
    // rather than an ambiguous all-unchecked state that happens to mean
    // the same thing. Both use a plain low-to-high ramp rather than the
    // generic decay shape for whenever fixed gets turned off -- a
    // predictable sweep to opt into, not a specific creative choice
    // baked into the default.
    positionMotion: {
      ...createMotionConfig(0, 1.0, ascendingCurve(), 0),
      useFixed: true,
    },
    durationMotion: {
      ...createMotionConfig(0.01, 1.0, ascendingCurve(), 1),
      useFixed: true,
    },

    effects: [],
    sweepRoute: createSweepRoute(),
    lfoRoute: createLfoRoute(),
  };
}

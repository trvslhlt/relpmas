import {
  type AutomationLoopHandle,
  type BuiltEffectsChain,
  DRIFT_TICK_MS,
  type EffectSpec,
  type TriggerableModulator,
  buildEffectsChain,
  createTriggerableModulator,
  curvePositionAtElapsed,
  lerpFactorFor,
  retargetDelayMsFor,
  sampleCurveAt,
  scheduleAutomation,
  startAutomationLoop,
} from "bruit-kit/audio";
import { DirectionalSamplePlayer } from "bruit-kit/sources";
import type { WaveformRange } from "bruit-kit/ui";
import {
  type LfoRoute,
  type MotionConfig,
  type SampleNode,
  type SweepRoute,
  wrapFraction,
  wrappedLength,
} from "./sampleNode";

/** Two granularities: triggerStart/triggerEnd span a whole firing burst;
 * fireStart/fireEnd are per individual fire, for cascades that should
 * respond to each bounce. periodEnd is a third, independent timing: it
 * always lands exactly triggerPeriodSeconds after triggerStart, regardless
 * of how long the fires themselves actually take to play -- for cascades
 * that should wait out the node's own configured cadence rather than
 * however long its audio happens to last (see trigger()'s own doc
 * comment on why triggerEnd can't be reused for this). */
export type NodeEventType =
  | "triggerStart"
  | "triggerEnd"
  | "fireStart"
  | "fireEnd"
  | "periodEnd";

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  fromEvent: NodeEventType;
  toNodeId: string;
}

interface WanderState {
  current: number;
  wanderTarget: number;
  nextRetargetAt: number;
}

interface NodeRuntime {
  armed: boolean;
  nextTriggerAt: number | null;
  /** Set at the top of every trigger() call (manual, loop, or
   * graph-cascaded alike) -- any MotionConfig's duringTriggerEnabled
   * toggle measures elapsed time from this, not the raw audio clock, so
   * it restarts at curve position 0 on every trigger instead of
   * free-running independently of the node's own firing (see
   * evaluateMotion's own doc comment). */
  lastTriggerAt: number;
  /** How many triggers this node has had so far -- read (as "the index
   * to use right now") then incremented at the top of every trigger()
   * call, for acrossTriggersEnabled's own curve sampling. Unlike
   * lastTriggerAt (elapsed *time*), this advances by exactly 1 per
   * trigger event regardless of how much real time separates them --
   * see MotionConfig's own doc comment on why that distinction matters
   * for something evaluated once per fire. */
  triggerIndex: number;
  nextAlternatingDirection: "forward" | "backward";
  positionWander: WanderState | null;
  durationWander: WanderState | null;
  rateWander: WanderState | null;
  envelopeWander: WanderState | null;
  liveRange: WaveformRange;
}

/** A node's own audio path: its dedicated DirectionalSamplePlayer (voices
 * fire through this, not a shared one -- see the class doc below for why
 * each node needs its own instance) -> envelopeGain -> its own effect
 * chain -> the shared mix bus. envelopeGain is a permanent junction (like
 * MasterBus's own stable outputGain) whose identity never changes across
 * an effect-chain rebuild -- only its downstream connection (to whatever
 * the current chain.input is) and its own gain automation change; see
 * setNodeEffects and reconcileEnvelopeContinuous. It exists specifically
 * for envelopeMotion's Continuous mode (see SampleNode.envelopeMotion's
 * own doc comment) -- Trigger's baked-per-fire gain and Fire's per-sample
 * shape both go straight into playVoice's own gain/envelopeCurve options
 * instead, since envelopeGain is shared across every voice from this
 * player and can't express "this one fire is louder than that one." */
interface NodeAudio {
  player: DirectionalSamplePlayer;
  envelopeGain: GainNode;
  chain: BuiltEffectsChain;
  /** Non-null only while envelopeMotion.continuousEnabled is on for this
   * node -- see reconcileEnvelopeContinuous. */
  envelopeContinuousLoop: AutomationLoopHandle | null;
  /** Lazily created the first time this node's lfoRoute is enabled --
   * see reconcileLfoConnection. */
  modulator: TriggerableModulator | null;
  modulatorConnectedTo: AudioParam | null;
}

/** Floors (and caps) a rate multiplier before it's ever used for
 * `12 * Math.log2(rateMultiplier)` or as a division denominator --
 * evaluateMotion's own contribution-summing formula
 * (`sum - (n-1)*center`) has no floor, and *can* legitimately land at or
 * below 0 when more than one rateMotion domain is enabled at once (e.g.
 * duringTriggerEnabled + acrossTriggersEnabled both sampling near the
 * curve's own low end simultaneously) -- ordinary settings, not a
 * pathological edge case. `Math.log2` of a non-positive number is
 * `NaN`/`-Infinity`, and unlike position (wrapFraction) or duration
 * (already clamped), rate had nothing catching that before this: a
 * NaN `rateSemitones` makes that voice's own `totalFrames` (spanFrames /
 * rate, in the worklet) NaN too -- and since `elapsed >= totalFrames`
 * (the voice's own termination check) is never true once totalFrames is
 * NaN, the voice never ends. Confirmed by direct reproduction: it stays
 * in the worklet's voice pool forever, continuously mixing NaN into
 * every future render block via `+=` and silencing everything downstream
 * for the rest of the session -- not a one-time blip, and not fixed by
 * waiting. See SampleNodeEngine.panic() for the recovery path (clearing
 * a voice pool that's already stuck this way), which this prevents from
 * ever being needed for *this* particular cause. 0.01 matches
 * durationMotion's own floor for the same "shrink to a
 * sliver, never to nothing" reasoning; 100 is a generous but finite
 * ceiling against the same formula summing unexpectedly high. */
function clampRateMultiplier(value: number): number {
  return Math.min(100, Math.max(0.01, value));
}

/** Floors a per-fire baked envelope gain at 0 (unlike rate, a gain of
 * exactly 0 -- or briefly negative from evaluateMotion's own summing
 * formula -- is a perfectly valid, silent-but-not-pathological result,
 * not a NaN risk the way a non-positive rate is) and caps it well above
 * envelopeMotion's own default max (1.5) as a generous but finite
 * backstop against the same formula summing unexpectedly high with
 * several domains stacked at once. */
function clampEnvelopeGain(value: number): number {
  return Math.min(4, Math.max(0, value));
}

/** Projects a wander's own retarget-then-glide walk forward by `dtMs`
 * from `state`'s current values, without touching the shared runtime
 * state itself (that stays advanceWander/tick()'s job, on its own
 * independent DRIFT_TICK_MS real-time cadence).
 *
 * Needed because one trigger's whole multi-fire burst is built
 * synchronously, all at once, for fire times that haven't happened yet
 * -- every other curve-based domain (duringTrigger, fire,
 * acrossTriggers, continuous) is already a pure function of that future
 * time/burst-position/triggerIndex, so each fire in a burst correctly
 * gets its own value. Wander isn't: it's a live, continuously-ticking
 * value with no "what will this be at an arbitrary future instant"
 * function, so reading a WanderState's own `.current` directly (as
 * every fire in a burst used to) gave every fire in that burst the
 * exact same sample -- nothing advances it between one loop iteration
 * and the next, since the loop has no real elapsed time or awaits in it.
 *
 * Uses the same retarget-then-glide math advanceWander/driftMath use,
 * just evaluated at an arbitrary elapsed offset instead of stepping a
 * fixed DRIFT_TICK_MS at a time: within each retarget-bounded segment,
 * gliding toward whatever target is active uses the closed-form
 * continuous-time equivalent of applying lerpFactorFor's own per-tick
 * factor once every DRIFT_TICK_MS
 * (`1 - (1-lerpFactor)^(segmentMs/DRIFT_TICK_MS)`) rather than looping
 * tick by tick; a segment that crosses a retarget boundary rolls a
 * fresh random target and continues, same as the real thing eventually
 * would -- just computed ahead of time instead of waiting for it. Not
 * literally the same random draws the live runtime state will make when
 * real time actually gets there (this doesn't mutate `state`), but a
 * plausible, varying continuation of it -- a real improvement over every
 * fire sharing one frozen snapshot. */
function projectWander(
  state: WanderState,
  config: MotionConfig,
  dtMs: number,
): number {
  if (dtMs <= 0) return state.current;
  const nowMs = Date.now();
  const endAt = nowMs + dtMs;
  let current = state.current;
  let target = state.wanderTarget;
  let nextRetargetAt = state.nextRetargetAt;
  let simulatedAt = nowMs;
  const lerpFactor = lerpFactorFor(config.wanderSpeed);
  let guard = 0;
  while (simulatedAt < endAt && guard++ < 64) {
    const segmentEnd = Math.min(endAt, nextRetargetAt);
    const segmentMs = segmentEnd - simulatedAt;
    if (segmentMs > 0) {
      const factor = 1 - (1 - lerpFactor) ** (segmentMs / DRIFT_TICK_MS);
      current += (target - current) * factor;
    }
    simulatedAt = segmentEnd;
    if (simulatedAt >= nextRetargetAt) {
      target = config.min + Math.random() * (config.max - config.min);
      nextRetargetAt = simulatedAt + retargetDelayMsFor(config.wanderSpeed);
    }
  }
  return current;
}

/** Owns the loaded buffer, every SampleNode, and the single shared
 * scheduler tick that drives loop-mode triggering and range motion (see
 * PLAN's "Core model" -- arm -> trigger -> fire, and range motion's
 * position/length scalars). No graph/modulation-route support yet (later
 * PLAN steps build directly on this same engine rather than replacing it
 * -- fire() is already the one place a node's *current* range gets read
 * and handed to its player).
 *
 * Each node gets its own DirectionalSamplePlayer + BuiltEffectsChain pair,
 * not one shared player for every node: a player mixes all its own voices
 * into a single output *inside the worklet*, so there's no way to split
 * that back out into per-node signals afterward -- per-node effect chains
 * (PLAN step 8) need the split to happen before mixing, not after. Every
 * node's chain output joins the one shared mixBus, which is what
 * `.output` exposes onward to a master bus. */
export class SampleNodeEngine {
  private readonly mixBus: GainNode;
  private readonly nodes = new Map<string, SampleNode>();
  private readonly runtime = new Map<string, NodeRuntime>();
  private readonly audio = new Map<string, NodeAudio>();
  private readonly edges = new Map<string, GraphEdge>();
  private buffer: AudioBuffer | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private onLiveRangeChange:
    | ((id: string, range: WaveformRange) => void)
    | null = null;
  private onNodeEventFired:
    | ((id: string, event: NodeEventType) => void)
    | null = null;
  private nextEdgeId = 1;

  constructor(private readonly audioContext: AudioContext) {
    this.mixBus = audioContext.createGain();
  }

  get output(): AudioNode {
    return this.mixBus;
  }

  get currentTime(): number {
    return this.audioContext.currentTime;
  }

  async init(): Promise<void> {
    this.tickHandle = setInterval(() => this.tick(), DRIFT_TICK_MS);
  }

  dispose(): void {
    if (this.tickHandle !== null) clearInterval(this.tickHandle);
  }

  /** Fires whenever a node's live (possibly motion-moved) range changes --
   * a host UI typically wires this straight to
   * multiRangeWaveformView's setLiveOverlay. */
  onLiveRange(callback: (id: string, range: WaveformRange) => void): void {
    this.onLiveRangeChange = callback;
  }

  /** Fires whenever any node's triggerStart/triggerEnd/fireStart/fireEnd
   * happens -- for UI feedback (e.g. flashing a node in the patch graph)
   * purely; graph edges are evaluated internally, not by a caller
   * re-driving trigger() off this callback (see emitEvent's own doc on
   * why that split matters for timing). */
  onNodeEvent(callback: (id: string, event: NodeEventType) => void): void {
    this.onNodeEventFired = callback;
  }

  addEdge(
    fromNodeId: string,
    fromEvent: NodeEventType,
    toNodeId: string,
  ): string {
    const id = `edge-${this.nextEdgeId++}`;
    this.edges.set(id, { id, fromNodeId, fromEvent, toNodeId });
    return id;
  }

  removeEdge(id: string): void {
    this.edges.delete(id);
  }

  listEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }

  async loadSample(buffer: AudioBuffer): Promise<void> {
    this.buffer = buffer;
    await Promise.all(
      [...this.audio.values()].map((a) => a.player.loadSample(buffer)),
    );
  }

  hasSample(): boolean {
    return this.buffer !== null;
  }

  getBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /** Async (unlike a plain data-model add) since each node needs its own
   * worklet node spun up and, if a buffer's already loaded, primed with
   * it before it can usefully fire. */
  async addNode(node: SampleNode): Promise<void> {
    this.nodes.set(node.id, node);
    this.runtime.set(node.id, {
      armed: false,
      nextTriggerAt: null,
      lastTriggerAt: this.audioContext.currentTime,
      triggerIndex: 0,
      nextAlternatingDirection: "forward",
      positionWander: null,
      durationWander: null,
      rateWander: null,
      envelopeWander: null,
      liveRange: { ...node.range },
    });

    const player = new DirectionalSamplePlayer(this.audioContext);
    await player.init();
    if (this.buffer) await player.loadSample(this.buffer);
    const envelopeGain = this.audioContext.createGain();
    const chain = buildEffectsChain(this.audioContext, node.effects);
    player.connect(envelopeGain);
    envelopeGain.connect(chain.input);
    chain.output.connect(this.mixBus);
    this.audio.set(node.id, {
      player,
      envelopeGain,
      chain,
      envelopeContinuousLoop: null,
      modulator: null,
      modulatorConnectedTo: null,
    });
    this.reconcileEnvelopeContinuous(node.id);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    this.runtime.delete(id);
    const audio = this.audio.get(id);
    if (audio) {
      audio.player.panic();
      audio.envelopeContinuousLoop?.stop();
      audio.envelopeGain.disconnect();
      audio.chain.dispose();
      // Otherwise the modulator's oscillator (once created) runs forever
      // -- a stopped OscillatorNode can't restart, so this is only safe
      // because the node itself is being torn down too.
      audio.modulator?.dispose();
      this.audio.delete(id);
    }
    for (const edge of this.edges.values()) {
      if (edge.fromNodeId === id || edge.toNodeId === id) {
        this.edges.delete(edge.id);
      }
    }
  }

  /** Structural effects change (add/remove/reorder/select an effect) --
   * tears down and rebuilds this node's chain. For a value-only slider
   * drag, use setNodeEffectsLive instead (see its own doc). */
  setNodeEffects(id: string, effects: EffectSpec[]): void {
    const node = this.nodes.get(id);
    const audio = this.audio.get(id);
    if (!node || !audio) return;
    node.effects = effects;
    audio.envelopeGain.disconnect(audio.chain.input);
    audio.chain.dispose();
    const chain = buildEffectsChain(this.audioContext, effects);
    audio.envelopeGain.connect(chain.input);
    chain.output.connect(this.mixBus);
    audio.chain = chain;
    // The rebuilt chain's params are entirely new AudioParam instances --
    // without this, an active LFO route would keep its connection to the
    // old, now-disposed chain's param instead of the new one.
    this.reconcileLfoConnection(id);
  }

  /** Recovers from a voice that's stuck forever mixing NaN into its own
   * player's output on every render block (see clampRateMultiplier's own
   * doc comment for the confirmed way that happens -- a NaN
   * `totalFrames` whose `elapsed >= totalFrames` termination check is
   * never true), or from a per-node effect's own internal state getting
   * corrupted the same way -- clears every player's in-flight voices
   * (player.panic()'s own `this.voices = []`) and rebuilds every node's
   * effect chain from its own current EffectSpec[] (the same rebuild
   * setNodeEffects does, just for every node at once). Touches nothing
   * about any node's own SampleNode data (labels, ranges, motion
   * configs, the patch graph, ...) -- only the underlying Web Audio
   * nodes get recreated. See MasterBus.panic() for the other half of a
   * full recovery (the shared limiter + master effects chain), and
   * main.ts's own "Reset audio" handler for wiring both together. */
  panic(): void {
    for (const [id, node] of this.nodes) {
      const audio = this.audio.get(id);
      if (!audio) continue;
      audio.player.panic();
      this.setNodeEffects(id, node.effects);
    }
  }

  /** Value-only nudge (a range field's continuous "input" events) -- never
   * rebuilds the chain, just pushes each effect's own params into its
   * already-live node via BuiltEffectsChain.setParamsAt, so a drag doesn't
   * pay a disconnect/reconnect click at 60fps. */
  setNodeEffectsLive(id: string, effects: EffectSpec[]): void {
    const node = this.nodes.get(id);
    const audio = this.audio.get(id);
    if (!node || !audio) return;
    node.effects = effects;
    effects.forEach((spec, i) => audio.chain.setParamsAt(i, spec.params));
  }

  getNode(id: string): SampleNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(): SampleNode[] {
    return [...this.nodes.values()];
  }

  updateNode(id: string, patch: Partial<SampleNode>): void {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);
    // Continuous mode is the one envelopeMotion domain with a live side
    // effect outside the plain data model (an ongoing AudioParam
    // automation loop) -- every other field on every other MotionConfig
    // is pure data, read fresh next time it's needed, so only this one
    // patch key needs a reconcile call here.
    if (patch.envelopeMotion !== undefined) {
      this.reconcileEnvelopeContinuous(id);
    }
  }

  isArmed(id: string): boolean {
    return this.runtime.get(id)?.armed ?? false;
  }

  setArmed(id: string, armed: boolean): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    runtime.armed = armed;
    runtime.nextTriggerAt = armed ? this.audioContext.currentTime : null;
  }

  getLiveRange(id: string): WaveformRange | undefined {
    return this.runtime.get(id)?.liveRange;
  }

  /** One trigger cycle: starts the node's firing pattern -- a single
   * fire; a fixedCount burst of `fireCount` fires, gapped according to
   * `intervalCurve` sampled by fire index and remapped into
   * [intervalMinMs, intervalMaxMs]; a fullTrigger burst that keeps firing
   * (same intervalCurve, but sampled by elapsed time within the trigger
   * instead of fire index) for as long as the node's own
   * triggerPeriodSeconds lasts; or a randomTrigger burst, the same
   * open-ended "for as long as the trigger lasts" shape as fullTrigger
   * but with each gap drawn uniformly at random from [intervalMinMs,
   * intervalMaxMs] instead of following intervalCurve (see
   * FiringPattern's own doc comment) -- callable directly (a manual
   * click) or by the scheduler tick (a loop-armed node's next due
   * trigger). Each fire reads the
   * range motion's *precisely computed future* value for curve-driven
   * motion (a pure function of time), or the current wander snapshot for
   * wander-driven motion (not predictable ahead of time without
   * simulating the random walk forward, which isn't worth the complexity
   * here).
   *
   * A no-op while disarmed ("off" in the node menu's own header toggle),
   * regardless of *how* trigger() was reached -- a manual click
   * (main.ts's own Trigger button), a loop-armed node's next due tick,
   * or a graph-cascaded edge (emitEvent calls this same method) are all
   * silenced the same way, since this is the one place all three paths
   * converge. fireNow() is a deliberate exception: it's documented as
   * bypassing arm/trigger entirely, so it stays unaffected by armed.
   *
   * Every fire's own time is computed in a first pass (gaps depend only
   * on intervalCurve/fireCount/triggerPeriodSeconds, never on duration)
   * before any of them actually fire, so a fireEnabled curve can be swept
   * across the burst's own real span -- first fire = curve position 0,
   * last fire = curve position 1 -- rather than sampled off the
   * continuous audio clock the way a duringTriggerEnabled curve is (see
   * evaluateMotion's own doc comment): with only one fire, "position
   * within this burst" is always exactly 0, which is why fireEnabled (or
   * duringTriggerEnabled) alone freezes a single-fire node's value at the
   * curve's own start -- acrossTriggersEnabled (or continuousEnabled) is
   * the way to get real movement out of a single-fire node instead. */
  trigger(id: string): void {
    const node = this.nodes.get(id);
    const runtime = this.runtime.get(id);
    const audio = this.audio.get(id);
    if (!node || !runtime || !audio || !this.buffer) return;
    if (!runtime.armed) return;

    const now = this.audioContext.currentTime;

    // Resyncs positionMotion's curve phase to 0 right as this trigger
    // starts -- see NodeRuntime.lastTriggerAt's own doc comment.
    runtime.lastTriggerAt = now;
    // The index this trigger's own fires use for acrossTriggersEnabled,
    // captured before bumping it for the *next* trigger -- see
    // NodeRuntime.triggerIndex's own doc comment.
    const triggerIndex = runtime.triggerIndex;
    runtime.triggerIndex += 1;

    this.emitEvent(id, "triggerStart");

    // Shared by fullTrigger/randomTrigger below -- a hard cap on fire
    // count, independent of triggerPeriodSeconds, guarding against a
    // runaway loop if intervalMinMs is ever 0 or near-0 (each gap is
    // also floored at 1ms in both branches, but this is a second,
    // unconditional line of defense).
    const MAX_OPEN_ENDED_FIRES = 500;

    const fireTimes = [now];
    if (node.firingPattern === "fixedCount") {
      const count = Math.max(1, node.fireCount);
      for (let i = 1; i < count; i++) {
        const t = count > 1 ? i / (count - 1) : 0;
        const gapMs = sampleCurveAt(node.intervalCurve, t, {
          min: node.intervalMinMs,
          max: node.intervalMaxMs,
        });
        fireTimes.push(
          fireTimes[fireTimes.length - 1] + Math.max(0, gapMs) / 1000,
        );
      }
    } else if (node.firingPattern === "fullTrigger") {
      // Same intervalCurve as fixedCount, but sampled by elapsed time
      // within the trigger (0 at trigger start, 1 a full
      // triggerPeriodSeconds later) rather than by fire index -- there's
      // no fixed count to index by, since firing continues for as long
      // as the trigger's own period lasts. Each fire reads the curve at
      // its own position to decide the delay before the *next* fire, so
      // the curve's shape sweeps across real time over the course of the
      // trigger (e.g. a decaying curve means gaps shrink -- firing
      // accelerates -- as the trigger goes on).
      while (fireTimes.length < MAX_OPEN_ENDED_FIRES) {
        const elapsedFraction = Math.min(
          1,
          (fireTimes[fireTimes.length - 1] - now) / node.triggerPeriodSeconds,
        );
        const gapMs = sampleCurveAt(node.intervalCurve, elapsedFraction, {
          min: node.intervalMinMs,
          max: node.intervalMaxMs,
        });
        const nextTime =
          fireTimes[fireTimes.length - 1] + Math.max(1, gapMs) / 1000;
        if (nextTime - now >= node.triggerPeriodSeconds) break;
        fireTimes.push(nextTime);
      }
    } else if (node.firingPattern === "randomTrigger") {
      // Same "keep firing for the whole trigger period" shape as
      // fullTrigger, but each gap is drawn uniformly at random from
      // [intervalMinMs, intervalMaxMs] instead of following
      // intervalCurve -- an unshaped, jittery machine-gun rather than a
      // deliberately swept one.
      while (fireTimes.length < MAX_OPEN_ENDED_FIRES) {
        const gapMs =
          node.intervalMinMs +
          Math.random() * Math.max(0, node.intervalMaxMs - node.intervalMinMs);
        const nextTime =
          fireTimes[fireTimes.length - 1] + Math.max(1, gapMs) / 1000;
        if (nextTime - now >= node.triggerPeriodSeconds) break;
        fireTimes.push(nextTime);
      }
    }
    const count = fireTimes.length;

    let lastFireEndTime = now;
    for (let i = 0; i < count; i++) {
      const fireTime = fireTimes[i];
      const range = this.rangeAtTime(node, runtime, fireTime, triggerIndex);
      const direction = this.resolveDirection(node, runtime);
      const rateMultiplier = clampRateMultiplier(
        this.evaluateMotion(
          node.rateMotion,
          runtime.rateWander,
          fireTime,
          runtime.lastTriggerAt,
          node.triggerPeriodSeconds,
          triggerIndex,
          1,
        ),
      );
      const envelopeGain = this.computeEnvelopeGain(
        node,
        runtime,
        fireTime,
        triggerIndex,
      );
      audio.player.playVoice({
        startFraction: range.start,
        endFraction: range.end,
        direction,
        fadeMs: node.fadeMs,
        envelopeCurve: node.envelopeMotion.fireEnabled
          ? node.envelopeMotion.fireCurvePoints
          : undefined,
        gain: envelopeGain,
        rateSemitones: 12 * Math.log2(rateMultiplier),
        time: fireTime,
      });

      const durationSeconds =
        (wrappedLength(range.start, range.end) * this.buffer.duration) /
        rateMultiplier;
      const fireEndTime = fireTime + durationSeconds;
      lastFireEndTime = fireEndTime;
      this.scheduleEvent(id, "fireStart", fireTime - now);
      this.scheduleEvent(id, "fireEnd", fireEndTime - now);
    }
    this.scheduleEvent(id, "triggerEnd", lastFireEndTime - now);
    this.scheduleEvent(id, "periodEnd", node.triggerPeriodSeconds);

    this.triggerSweepRoute(node, audio, now);
    this.triggerLfoRoute(node, audio, now);
  }

  /** Schedules a UI-feedback-and-graph-evaluation event `delaySeconds` from
   * now via a plain JS timer -- not sample-accurate (ordinary setTimeout
   * jitter), which is fine for this: it drives cascading triggers and
   * on-screen flashes, not the audio itself (each fire's actual sound is
   * already scheduled sample-accurately on the DirectionalSamplePlayer via
   * its own `time` argument, independent of this). */
  private scheduleEvent(
    id: string,
    event: NodeEventType,
    delaySeconds: number,
  ): void {
    setTimeout(
      () => this.emitEvent(id, event),
      Math.max(0, delaySeconds * 1000),
    );
  }

  /** Notifies the UI callback, then walks outgoing graph edges for this
   * exact (nodeId, event) pair and triggers every target -- a cascade can
   * itself schedule further cascades (a chain of nodes triggering each
   * other), each one independently timed off its own fires the same way. */
  private emitEvent(id: string, event: NodeEventType): void {
    this.onNodeEventFired?.(id, event);
    for (const edge of this.edges.values()) {
      if (edge.fromNodeId === id && edge.fromEvent === event) {
        this.trigger(edge.toNodeId);
      }
    }
  }

  /** Fires once per trigger (not per fire -- see SweepRoute's own doc):
   * ramps the target AudioParam directly, over the node's own
   * triggerPeriodSeconds rather than an independent duration -- so a
   * loop-armed node's sweep always resolves exactly as the next trigger
   * arrives, never mid-ramp or sitting idle at its endpoint waiting for
   * the next one. A target that doesn't resolve (no effect selected, or
   * the selected effect no longer has that many params -- realistic if
   * effects were edited after this route was set up) is silently skipped
   * rather than throwing, same tolerance BuiltEffectsChain.getAudioParam
   * itself documents. */
  private triggerSweepRoute(
    node: SampleNode,
    audio: NodeAudio,
    atTime: number,
  ): void {
    const route = node.sweepRoute;
    if (!route.enabled) return;
    const target = audio.chain.getAudioParam(
      route.targetEffectIndex,
      route.targetParamKey,
    );
    if (!target) return;
    scheduleAutomation(
      target,
      route.curvePoints,
      this.audioContext,
      node.triggerPeriodSeconds,
      { min: route.valueMin, max: route.valueMax },
      atTime,
    );
  }

  /** Fires once per trigger: ramps a lazily-created TriggerableModulator's
   * own rate/depth while it continuously modulates the target -- see
   * LfoRoute's own doc comment. The modulator's actual connect/disconnect
   * lifecycle lives in reconcileLfoConnection, not here, since that also
   * needs to run on route changes and effect-chain rebuilds, not just on
   * trigger. */
  private triggerLfoRoute(
    node: SampleNode,
    audio: NodeAudio,
    atTime: number,
  ): void {
    const route = node.lfoRoute;
    if (!route.enabled || !audio.modulator || !audio.modulatorConnectedTo) {
      return;
    }
    scheduleAutomation(
      audio.modulator.rateParam,
      route.curvePoints,
      this.audioContext,
      node.triggerPeriodSeconds,
      { min: route.valueMin, max: route.valueMax },
      atTime,
    );
    scheduleAutomation(
      audio.modulator.depthParam,
      route.depthCurvePoints,
      this.audioContext,
      node.triggerPeriodSeconds,
      { min: route.depthMin, max: route.depthMax },
      atTime,
    );
  }

  /** Resolves node.lfoRoute against the node's *current* effect chain and
   * brings the modulator's actual connection in line with it -- called
   * whenever the route itself changes (setNodeLfoRoute) or the chain is
   * rebuilt (setNodeEffects), since a rebuilt chain's params are entirely
   * new AudioParam instances that any prior connection would otherwise
   * silently keep pointing at stale, disposed ones. Disabling the route,
   * or a target that no longer resolves, disconnects rather than leaving
   * the oscillator's last-scheduled output permanently feeding into
   * whatever it was last connected to. */
  private reconcileLfoConnection(id: string): void {
    const node = this.nodes.get(id);
    const audio = this.audio.get(id);
    if (!node || !audio) return;
    const route = node.lfoRoute;
    const target = route.enabled
      ? audio.chain.getAudioParam(route.targetEffectIndex, route.targetParamKey)
      : undefined;
    if (!target) {
      audio.modulator?.disconnect();
      audio.modulatorConnectedTo = null;
      return;
    }
    if (!audio.modulator) {
      audio.modulator = createTriggerableModulator(this.audioContext);
    }
    audio.modulator.connect(target);
    audio.modulatorConnectedTo = target;
  }

  /** Starts, restarts, or stops envelopeMotion's Continuous automation
   * loop on this node's own envelopeGain -- called from addNode (initial
   * state) and updateNode (any subsequent envelopeMotion edit). Always
   * stops whatever loop is currently running first, then starts a fresh
   * one if continuousEnabled is on: unlike curvePoints/
   * continuousLoopSeconds (re-read live every cycle by
   * startAutomationLoop's own getter callbacks, so those two take effect
   * without a restart), min/max are captured as a fixed valueRange
   * snapshot when the loop starts, so an edit to either only actually
   * takes effect via this restart. Cheap and click-free either way --
   * scheduleAutomation's own cancelAndHoldAtTime anchors the new curve at
   * wherever the old one actually was, not a hard jump (see its own doc
   * comment). No-op (loop left null) while useFixed is on, or while
   * neither useFixed nor continuousEnabled is -- Continuous is mutually
   * exclusive with Fixed same as every other MotionConfig here (see
   * nodeMenu.ts's own grid). */
  private reconcileEnvelopeContinuous(id: string): void {
    const node = this.nodes.get(id);
    const audio = this.audio.get(id);
    if (!node || !audio) return;
    audio.envelopeContinuousLoop?.stop();
    if (node.envelopeMotion.continuousEnabled) {
      audio.envelopeContinuousLoop = startAutomationLoop(
        audio.envelopeGain.gain,
        this.audioContext,
        () => this.nodes.get(id)?.envelopeMotion.continuousCurvePoints ?? [],
        () => this.nodes.get(id)?.envelopeMotion.continuousLoopSeconds ?? 4,
        { min: node.envelopeMotion.min, max: node.envelopeMotion.max },
      );
    } else {
      audio.envelopeContinuousLoop = null;
      // stop() only clears the JS-side timeout -- any ramp segments the
      // last tick already scheduled on the AudioParam itself can still
      // be mid-flight up to continuousLoopSeconds in the future, so
      // switching away from Continuous needs an explicit cancel back to
      // unity rather than just leaving those to finish on their own.
      const now = this.audioContext.currentTime;
      audio.envelopeGain.gain.cancelScheduledValues(now);
      audio.envelopeGain.gain.setValueAtTime(1, now);
    }
  }

  /** Updates the node's sweep route and immediately cancels any pending
   * automation on whatever it currently targets -- a sweep has no
   * persistent connection to reconcile (unlike the LFO's oscillator), but
   * a disabled/retargeted route would otherwise leave an already-scheduled
   * ramp free to keep firing until it finishes on its own, silently
   * overriding a manual effect-panel slider change in the meantime (see
   * the module's own note on the bug this fixes). */
  setNodeSweepRoute(id: string, route: SweepRoute): void {
    const node = this.nodes.get(id);
    const audio = this.audio.get(id);
    if (!node || !audio) return;
    node.sweepRoute = route;
    const target = audio.chain.getAudioParam(
      route.targetEffectIndex,
      route.targetParamKey,
    );
    target?.cancelScheduledValues(this.audioContext.currentTime);
  }

  /** Updates the node's LFO route and reconciles the modulator's actual
   * connection immediately (not just on the next trigger), so disabling
   * it or changing its target takes effect right away. */
  setNodeLfoRoute(id: string, route: LfoRoute): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.lfoRoute = route;
    this.reconcileLfoConnection(id);
  }

  /** Immediate, direct fire -- bypasses arm/trigger/firing-pattern
   * entirely, always exactly one fire using whatever range is live right
   * now. Kept distinct from trigger() for callers (like the UI's per-node
   * "Fire" escape hatch) that want a guaranteed single sound regardless
   * of the node's own configured firing pattern. */
  fireNow(id: string): number | null {
    const node = this.nodes.get(id);
    const runtime = this.runtime.get(id);
    const audio = this.audio.get(id);
    if (!node || !runtime || !audio || !this.buffer) return null;
    const range = runtime.liveRange;
    const direction = this.resolveDirection(node, runtime);
    const rateMultiplier = clampRateMultiplier(
      this.evaluateMotion(
        node.rateMotion,
        runtime.rateWander,
        this.audioContext.currentTime,
        runtime.lastTriggerAt,
        node.triggerPeriodSeconds,
        runtime.triggerIndex,
        1,
      ),
    );
    const envelopeGain = this.computeEnvelopeGain(
      node,
      runtime,
      this.audioContext.currentTime,
      runtime.triggerIndex,
    );
    return audio.player.playVoice({
      startFraction: range.start,
      endFraction: range.end,
      direction,
      fadeMs: node.fadeMs,
      envelopeCurve: node.envelopeMotion.fireEnabled
        ? node.envelopeMotion.fireCurvePoints
        : undefined,
      gain: envelopeGain,
      rateSemitones: 12 * Math.log2(rateMultiplier),
    });
  }

  private resolveDirection(
    node: SampleNode,
    runtime: NodeRuntime,
  ): "forward" | "backward" {
    if (node.direction !== "alternating") return node.direction;
    const next = runtime.nextAlternatingDirection;
    runtime.nextAlternatingDirection =
      next === "forward" ? "backward" : "forward";
    return next;
  }

  /** Computes the range motion at an arbitrary (possibly future) time --
   * curve contributions are exact (curvePositionAtElapsed is a pure
   * function), wander contributions use the current wander snapshot
   * regardless of how far `atTime` is from now.
   *
   * node.range is the node's candidate playback area, not just its
   * no-motion default: position/duration motion work entirely in
   * coordinates local to that range (0 = the range's own start, 1 = its
   * own end for position; 0 = a sliver, 1 = the range's own full length
   * for duration) and only get mapped into absolute buffer fractions at
   * the very end, so a fire can never land outside the selected range. A
   * local fragment that would run past the range's own end wraps back to
   * the range's own start, same wraparound semantics as the range itself
   * (see wrappedLength's own doc comment) just rescoped one level in.
   *
   * `triggerIndex` defaults to the runtime's own current value (tick()'s
   * continuous live-overlay evaluation has no specific trigger to pass
   * one from), but trigger() itself passes its own captured index
   * explicitly so every fire in one trigger's burst uses the same
   * acrossTriggersEnabled contribution, even though duringTriggerEnabled
   * can still differ per fire. */
  private rangeAtTime(
    node: SampleNode,
    runtime: NodeRuntime,
    atTime: number,
    triggerIndex: number = runtime.triggerIndex,
  ): WaveformRange {
    const rangeStart = node.range.start;
    const rangeLength = wrappedLength(node.range.start, node.range.end);

    // Falls back to "the range's own start, at its full length" when
    // nothing is enabled -- the same no-motion behavior as before, just
    // expressed in the range's own local terms instead of absolute ones.
    const localStart = this.evaluateMotion(
      node.positionMotion,
      runtime.positionWander,
      atTime,
      runtime.lastTriggerAt,
      node.triggerPeriodSeconds,
      triggerIndex,
      0,
    );
    const localDuration = this.evaluateMotion(
      node.durationMotion,
      runtime.durationWander,
      atTime,
      runtime.lastTriggerAt,
      node.triggerPeriodSeconds,
      triggerIndex,
      1,
    );

    // Floored at 0.01 (not 0) per durationMotion's own contract -- a
    // fire's duration can shrink to a sliver but never fully silence.
    // Capped at 1 (a full lap of the range, no more) since summing several
    // active contributions can exceed either alone (see evaluateMotion's
    // own doc) -- unlike the old formula this replaces, there's no
    // precision reason for the cap anymore, just a semantic one: more than
    // one full lap wraps back on itself and would just as likely show
    // *less* than a full range's worth once wrapped, not more.
    const clampedLocalDuration = Math.min(1, Math.max(0.01, localDuration));

    // end is computed directly from the *absolute* start plus the local
    // duration scaled by rangeLength, wrapped exactly once -- not by
    // wrapping a separate "local end" (start + duration, wrapped in local
    // 0..1 terms) and then rescaling *that* into absolute space. The two
    // are mathematically equivalent, but the latter loses precision right
    // where it matters most: wrapping a near-1 local duration first
    // produces a value a few ULPs below wrappedLocalStart, and rescaling
    // that by a small rangeLength (e.g. 0.4) can round the tiny gap's
    // *sign*, turning "almost the full range" into "almost nothing" --
    // exactly backwards, and only once position motion made start != 0
    // (with start pinned at 0, rescaling a sub-1 local end never crosses
    // zero, which is why this stayed hidden until position motion was
    // exercised alongside duration motion).
    const start = wrapFraction(
      rangeStart + wrapFraction(localStart) * rangeLength,
    );
    const end = wrapFraction(start + clampedLocalDuration * rangeLength);

    return { start, end };
  }

  /** Unified evaluator for all three of a node's independently-modulated
   * live scalars (position, duration, rate) -- see MotionConfig's own doc
   * comment for the full explanation of the five ways a value can move,
   * and why enabling more than one sums their contributions rather than
   * picking just one.
   *
   * `useFixed` short-circuits everything below it. Otherwise each enabled
   * toggle contributes its own sampled value:
   * - duringTriggerEnabled: curvePositionAtElapsed relative to
   *   `lastTriggerAt`, looped over `triggerPeriodSeconds` -- restarts at
   *   curve position 0 on every trigger, same trigger-relative timing
   *   sweepRoute/lfoRoute already use for their own ramps.
   * - fireEnabled: a fresh uniform-random draw within [min, max] --
   *   baked into that one voice at the instant it's computed, never
   *   re-evaluated during its own playback (see MotionConfig's own
   *   fireEnabled doc comment for envelope's own, different Fire
   *   mechanism, which never reaches this branch at all).
   * - acrossTriggersEnabled: sampleCurveAt (`triggerIndex` modulo the
   *   config's own `triggerCycleLength`) / `triggerCycleLength` -- steps
   *   exactly once per trigger *event*, not per unit of elapsed time, so
   *   (unlike duringTriggerEnabled/fireEnabled) it actually moves for a
   *   single-fire node retriggered at any tempo, steady or not.
   * - continuousEnabled: curvePositionAtElapsed against the raw `atTime`
   *   (not relative to any trigger), looped over the config's own
   *   `continuousLoopSeconds` -- entirely independent of triggers or
   *   fires, never resets.
   * - useWander: bruit-kit's driftMath retarget-then-glide random walk,
   *   projected forward from its own live state to `atTime` (see
   *   projectWander's own doc comment for why a future fire can't just
   *   read the live snapshot directly the way every other domain above
   *   reads its own curve at a future position) -- continuous and
   *   trigger-independent like continuousEnabled, but random instead of a
   *   drawn shape.
   *
   * All active contributions are summed, then recentered by
   * `(n - 1) * center` (center = the midpoint of [min,max]) so exactly
   * one contribution reads as itself, two reproduce the old "both"
   * formula, and so on for any combination -- rangeAtTime clamps the
   * final composed start/length hard against buffer bounds regardless,
   * so exceeding [min,max] here from summing several at once is safe.
   * Zero enabled contributions (and useFixed off) returns `fallback`.
   *
   * useFixed + useWander together is the one exception to "useFixed
   * short-circuits everything else": wander is a noise source layered on
   * whatever mode a control is in, not a mode of its own to pick between
   * (see MotionConfig's own doc comment on useWander) -- so a fixed
   * value still wobbles by wander's own current deviation from its
   * range's center, rather than wander being silently ignored just
   * because useFixed happens to also be on. */
  private evaluateMotion(
    config: MotionConfig,
    wander: WanderState | null,
    atTime: number,
    lastTriggerAt: number,
    triggerPeriodSeconds: number,
    triggerIndex: number,
    fallback: number,
  ): number {
    // How far in the future (or, for a live/present-time call like
    // tick()'s own overlay or fireNow(), effectively zero) atTime is from
    // right now, in wall-clock ms -- see projectWander's own doc comment
    // for why wander specifically needs this and every other domain
    // here doesn't.
    const wanderDtMs = (atTime - this.audioContext.currentTime) * 1000;

    if (config.useFixed) {
      if (config.useWander && wander) {
        const center = (config.min + config.max) / 2;
        return (
          config.fixedValue +
          (projectWander(wander, config, wanderDtMs) - center)
        );
      }
      return config.fixedValue;
    }

    const range = { min: config.min, max: config.max };
    const contributions: number[] = [];

    if (config.duringTriggerEnabled) {
      contributions.push(
        curvePositionAtElapsed(
          config.triggerCurvePoints,
          atTime - lastTriggerAt,
          triggerPeriodSeconds,
          range,
        ),
      );
    }
    if (config.fireEnabled) {
      // Uniform random draw within [min, max], freshly rolled per fire --
      // not a curve sample. This branch is only ever reached by Rate/
      // Duration/Position (Envelope's own fireEnabled bypasses
      // evaluateMotion entirely, forced off in computeEnvelopeGain's own
      // bakedConfig, since its Fire mode is a genuine per-sample worklet
      // shape rather than a per-fire scalar -- see MotionConfig's own
      // doc comment on fireEnabled for why the two diverge). A drawn
      // curve sampled by burst position implied a deliberate sweep
      // across a burst, which doesn't fit "Fire" as well as plain
      // per-fire jitter does for a value that's baked once before a
      // fire starts and can't change while it plays either way.
      contributions.push(range.min + Math.random() * (range.max - range.min));
    }
    if (config.acrossTriggersEnabled) {
      const cycleLength = Math.max(1, Math.round(config.triggerCycleLength));
      contributions.push(
        sampleCurveAt(
          config.triggerCurvePoints,
          (triggerIndex % cycleLength) / cycleLength,
          range,
        ),
      );
    }
    if (config.continuousEnabled) {
      contributions.push(
        curvePositionAtElapsed(
          config.continuousCurvePoints,
          atTime,
          config.continuousLoopSeconds,
          range,
        ),
      );
    }
    if (config.useWander && wander) {
      contributions.push(projectWander(wander, config, wanderDtMs));
    }

    if (contributions.length === 0) return fallback;
    const center = (config.min + config.max) / 2;
    const sum = contributions.reduce((a, b) => a + b, 0);
    return sum - (contributions.length - 1) * center;
  }

  /** The one per-fire scalar out of envelopeMotion's four modes --
   * "Trigger" (during/across), baked once via evaluateMotion exactly
   * like Rate's own during/across, plus useWander/useFixed's ordinary
   * evaluateMotion behavior on top. Continuous and Fire are deliberately
   * excluded here (forced off on a local copy of the config) since they
   * reach the final sound through entirely different paths -- Continuous
   * via envelopeGain's own ongoing AudioParam automation
   * (reconcileEnvelopeContinuous), Fire via a per-voice lookup table sent
   * straight to playVoice's own envelopeCurve option (see trigger()/
   * fireNow()) -- summing either into this baked scalar too would double
   * them up. Returns 1 (neutral) when neither useFixed nor during/across
   * is on, same fallback convention every other MotionConfig call uses. */
  private computeEnvelopeGain(
    node: SampleNode,
    runtime: NodeRuntime,
    atTime: number,
    triggerIndex: number,
  ): number {
    const bakedConfig: MotionConfig = {
      ...node.envelopeMotion,
      continuousEnabled: false,
      fireEnabled: false,
    };
    return clampEnvelopeGain(
      this.evaluateMotion(
        bakedConfig,
        runtime.envelopeWander,
        atTime,
        runtime.lastTriggerAt,
        node.triggerPeriodSeconds,
        triggerIndex,
        1,
      ),
    );
  }

  /** Advances every armed node's range motion and due loop triggers.
   * Range-motion bookkeeping (wander retarget/glide) mirrors
   * grid-sequencer's own driftEngine.ts pattern, built on the same
   * bruit-kit driftMath primitives. */
  private tick(): void {
    const now = this.audioContext.currentTime;
    for (const [id, node] of this.nodes) {
      const runtime = this.runtime.get(id);
      if (!runtime) continue;

      this.advanceWander(node.positionMotion, "positionWander", runtime);
      this.advanceWander(node.durationMotion, "durationWander", runtime);
      this.advanceWander(node.rateMotion, "rateWander", runtime);
      this.advanceWander(node.envelopeMotion, "envelopeWander", runtime);

      const nextRange = this.rangeAtTime(node, runtime, now);
      if (
        nextRange.start !== runtime.liveRange.start ||
        nextRange.end !== runtime.liveRange.end
      ) {
        runtime.liveRange = nextRange;
        this.onLiveRangeChange?.(id, nextRange);
      }

      if (
        runtime.armed &&
        node.armMode === "loop" &&
        runtime.nextTriggerAt !== null &&
        now >= runtime.nextTriggerAt
      ) {
        this.trigger(id);
        runtime.nextTriggerAt = now + Math.max(0.01, node.triggerPeriodSeconds);
      }
    }
  }

  private advanceWander(
    config: MotionConfig,
    key: "positionWander" | "durationWander" | "rateWander" | "envelopeWander",
    runtime: NodeRuntime,
  ): void {
    if (!config.useWander) {
      runtime[key] = null;
      return;
    }
    const nowMs = Date.now();
    let state = runtime[key];
    if (!state) {
      const mid = (config.min + config.max) / 2;
      state = {
        current: mid,
        wanderTarget: mid,
        nextRetargetAt: nowMs + retargetDelayMsFor(config.wanderSpeed),
      };
      runtime[key] = state;
    }
    if (nowMs >= state.nextRetargetAt) {
      state.wanderTarget =
        config.min + Math.random() * (config.max - config.min);
      state.nextRetargetAt = nowMs + retargetDelayMsFor(config.wanderSpeed);
    }
    state.current +=
      (state.wanderTarget - state.current) * lerpFactorFor(config.wanderSpeed);
  }
}

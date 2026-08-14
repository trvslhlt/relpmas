import {
  type BuiltEffectsChain,
  type EffectSpec,
  LimiterEffect,
  buildEffectsChain,
} from "bruit-kit/audio";

/** The one place every node's mix bus funnels through before speakers:
 * `source` (SampleNodeEngine.output) -> this bus's own EffectSpec[] chain
 * -> a shared, always-fully-engaged LimiterEffect -> a stable output
 * GainNode -> destination. Mirrors SampleNodeEngine's own two-tier
 * setEffects/setEffectsLive split for the same reason (a rebuild on every
 * slider drag would click). `.output` exposes that stable post-limiter
 * node -- "exactly what's heard" -- for a Recorder to tap (PLAN step 11);
 * it's a plain GainNode whose identity never changes (see panic()'s own
 * doc comment for why that matters), unlike the limiter/chain behind it. */
export class MasterBus {
  private limiter: LimiterEffect;
  private readonly outputGain: GainNode;
  private chain: BuiltEffectsChain;
  private effects: EffectSpec[] = [];

  constructor(
    private readonly audioContext: AudioContext,
    private readonly source: AudioNode,
  ) {
    this.outputGain = audioContext.createGain();
    this.limiter = new LimiterEffect(audioContext);
    this.limiter.output.connect(this.outputGain);
    this.outputGain.connect(audioContext.destination);
    this.chain = buildEffectsChain(audioContext, this.effects);
    this.source.connect(this.chain.input);
    this.chain.output.connect(this.limiter.input);
  }

  getEffects(): EffectSpec[] {
    return this.effects;
  }

  setEffects(effects: EffectSpec[]): void {
    this.effects = effects;
    this.source.disconnect(this.chain.input);
    this.chain.dispose();
    this.chain = buildEffectsChain(this.audioContext, effects);
    this.source.connect(this.chain.input);
    this.chain.output.connect(this.limiter.input);
  }

  setEffectsLive(effects: EffectSpec[]): void {
    this.effects = effects;
    effects.forEach((spec, i) => this.chain.setParamsAt(i, spec.params));
  }

  /** Recreates the shared limiter and the master effects chain from
   * scratch. The confirmed, reproduced way audio gets stuck silent for
   * the rest of a session is a worklet voice whose own termination check
   * can never come true once its totalFrames is NaN (see
   * SampleNodeEngine.clampRateMultiplier's own doc comment) -- fixing
   * that requires clearing the voice itself, which is
   * SampleNodeEngine.panic()'s job, not this one. This rebuild is the
   * complementary, defensive half: a feedback effect on the *master*
   * chain (a delay/flanger/comb filter/reverb) has its own internal
   * state that a sustained burst of NaN could plausibly leave corrupted
   * even after the source voice is cleared, so this recreates it too,
   * cheaply, as part of the same recovery rather than leaving it as a
   * second, separate failure mode to debug later. `.output` is a stable
   * wrapper GainNode that's never itself recreated here -- a plain
   * GainNode has no internal recursive state to get stuck in the first
   * place, and keeping its identity stable means an external connection
   * made against it before a panic() (Recorder's own tap, set up once at
   * startup) keeps working afterward without needing to reconnect. See
   * SampleNodeEngine.panic() for the other (necessary) half of a full
   * recovery, and main.ts's own "Reset audio" handler for wiring both
   * together. */
  panic(): void {
    this.source.disconnect(this.chain.input);
    this.chain.dispose();
    this.limiter.output.disconnect(this.outputGain);
    this.limiter = new LimiterEffect(this.audioContext);
    this.limiter.output.connect(this.outputGain);
    this.chain = buildEffectsChain(this.audioContext, this.effects);
    this.source.connect(this.chain.input);
    this.chain.output.connect(this.limiter.input);
  }

  get output(): AudioNode {
    return this.outputGain;
  }
}

import {
  type BuiltEffectsChain,
  type EffectSpec,
  LimiterEffect,
  buildEffectsChain,
} from "bruit-kit/audio";

/** The one place every node's mix bus funnels through before speakers:
 * `source` (SampleNodeEngine.output) -> this bus's own EffectSpec[] chain
 * -> a shared, always-fully-engaged LimiterEffect -> destination. Mirrors
 * SampleNodeEngine's own two-tier setEffects/setEffectsLive split for the
 * same reason (a rebuild on every slider drag would click). `.output`
 * exposes the post-limiter node -- "exactly what's heard" -- for a
 * Recorder to tap later (PLAN step 11). */
export class MasterBus {
  readonly limiter: LimiterEffect;
  private chain: BuiltEffectsChain;
  private effects: EffectSpec[] = [];

  constructor(
    private readonly audioContext: AudioContext,
    private readonly source: AudioNode,
  ) {
    this.limiter = new LimiterEffect(audioContext);
    this.limiter.output.connect(audioContext.destination);
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

  get output(): AudioNode {
    return this.limiter.output;
  }
}

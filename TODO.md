# TODO

- Rate motion's "curve" mode only evaluates once per fire (at that fire's
  own position within a curveSpaced burst, or at the curve's start for a
  single fire) and bakes the result into that voice's fixed playback
  rate for its whole duration — there's no live, continuous rate
  modulation *during* a single fire's own playback (no pitch bend/tape
  wobble mid-sample). That would need a different mechanism (e.g. an
  automated AudioParam the worklet reads continuously, like
  sweepRoute/lfoRoute already do for effect params) rather than the
  current perFireValue-style one-shot evaluation. See
  SampleNodeEngine.trigger()'s rateMultiplier computation.

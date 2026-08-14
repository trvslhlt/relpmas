# TODO

- Rate motion's curve-based domains (duringTrigger, fire, acrossTriggers)
  all evaluate once per fire and bake the result into that voice's fixed
  playback rate for its whole duration — there's no live, continuous rate
  modulation *during* a single fire's own playback (no pitch bend/tape
  wobble mid-sample). That would need a different mechanism (e.g. an
  automated AudioParam the worklet reads continuously, like
  sweepRoute/lfoRoute already do for effect params) rather than the
  current evaluateMotion-style one-shot evaluation. See
  SampleNodeEngine.trigger()'s rateMultiplier computation.

  Note this is a genuinely different thing from acrossTriggersEnabled
  (added to fix "rate doesn't seem to use the curve" for a single-fire
  node) -- that already gives a single-fire node a different rate on each
  successive *trigger*, stepped by trigger count. What's still missing
  here is movement *within* one fire's own playback, continuously, not
  just a new fixed value per trigger.

  Rate's "per fire" checkbox is still hidden from the UI (see
  nodeMenu.ts's motionFields' showFireOption) since it's still a no-op
  for the common single-fire case (no burst to sample a position
  within) -- acrossTriggersEnabled is the fix for that case, not this
  one.

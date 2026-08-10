// Runs in AudioWorkletGlobalScope alongside sources/granular-processor.js
// (see that file's own header for the shared clock/globals note). Same
// overlapping-grain idea as that file, just reading a live circular buffer
// of whatever signal is connected upstream instead of a static preloaded
// sample -- that's what lets this sit as a normal insert effect in an
// arbitrary chain (PitchShiftEffect) instead of being its own source.
//
// Technique: two "grains" sharing one circular history buffer per channel.
// Each grain is a fixed-length (GRAIN_SECONDS) Hann-windowed tap into that
// history, at a delay (behind the live write pointer) that sweeps
// continuously between 0 and the grain length. The sweep speed is derived
// from the desired playback-rate ratio -- delay grows when rate < 1 (pitch
// down, each grain lingers further into the past) and shrinks when rate >
// 1 (pitch up, each grain races toward "now"). When a grain's delay hits
// either edge it wraps back to the opposite edge; because the Hann window
// is exactly 0 at both edges, that wrap is inaudible. The two grains are
// offset by half a grain length so their windows sum to a constant (the
// standard 50%-overlap constant-overlap-add property of Hann windows),
// giving continuous, click-free output at any pitch ratio.
//
// No worklet-side "grain size" or "quality" knob is exposed -- PitchShiftEffect
// picks one fixed grain length rather than surfacing it, matching this
// project's "hide it, pick a sane default" call on shipping this effect.

const GRAIN_SECONDS = 0.08;

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.grainLength = Math.round(GRAIN_SECONDS * sampleRate);
    // 4 grain-lengths of history is comfortably more than either grain's
    // delay (which never exceeds one grain length) plus interpolation
    // margin -- oversized on purpose rather than tuned tight to this
    // effect's own semitone range, so a future wider pitch range doesn't
    // need this revisited.
    this.bufferLength = this.grainLength * 4;
    this.channelBuffers = [];
    this.writeIndex = 0;
    // Two grain delay-phases, shared across channels since every channel
    // plays back at the same rate -- only the sample history differs.
    this.delayA = 0;
    this.delayB = this.grainLength / 2;
    this.targetRate = 1;
    this.currentRate = 1;

    this.port.onmessage = (event) => {
      if (event.data.type === "setRate") this.targetRate = event.data.rate;
    };
  }

  ensureChannels(count) {
    while (this.channelBuffers.length < count) {
      this.channelBuffers.push(new Float32Array(this.bufferLength));
    }
  }

  readInterpolated(buffer, position) {
    const wrapped =
      ((position % this.bufferLength) + this.bufferLength) % this.bufferLength;
    const idx = Math.floor(wrapped);
    const frac = wrapped - idx;
    const next = (idx + 1) % this.bufferLength;
    return buffer[idx] * (1 - frac) + buffer[next] * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const channelCount = Math.max(output.length, 1);
    this.ensureChannels(channelCount);

    const blockSize = output[0]?.length ?? 128;
    // One-pole smoothing toward the target rate, ~15ms time constant --
    // avoids a zipper artifact if the user drags the pitch controls while
    // the effect is playing, without feeling sluggish to respond.
    const smoothing = Math.exp(-blockSize / (sampleRate * 0.015));

    for (let i = 0; i < blockSize; i++) {
      this.currentRate =
        this.targetRate + (this.currentRate - this.targetRate) * smoothing;
      const delta = 1 - this.currentRate;

      this.delayA =
        (((this.delayA + delta) % this.grainLength) + this.grainLength) %
        this.grainLength;
      this.delayB =
        (((this.delayB + delta) % this.grainLength) + this.grainLength) %
        this.grainLength;

      const windowA =
        0.5 * (1 - Math.cos((2 * Math.PI * this.delayA) / this.grainLength));
      const windowB =
        0.5 * (1 - Math.cos((2 * Math.PI * this.delayB) / this.grainLength));

      const posA = this.writeIndex - this.delayA;
      const posB = this.writeIndex - this.delayB;

      for (let ch = 0; ch < channelCount; ch++) {
        const buffer = this.channelBuffers[ch];
        const inputChannel = input[ch] ?? input[0];
        const inputSample = inputChannel ? inputChannel[i] : 0;

        const sampleA = this.readInterpolated(buffer, posA);
        const sampleB = this.readInterpolated(buffer, posB);
        output[ch][i] = sampleA * windowA + sampleB * windowB;

        buffer[this.writeIndex] = inputSample;
      }
      this.writeIndex = (this.writeIndex + 1) % this.bufferLength;
    }

    return true;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);

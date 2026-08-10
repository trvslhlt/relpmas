// Runs in AudioWorkletGlobalScope alongside pitch-shift-processor.js (see
// that file's own header for the shared clock/globals note).
//
// True sample-rate reduction (as opposed to BitcrusherEffect's amplitude
// quantization) needs to hold a sample's value across several real output
// samples before updating it -- a zero-order hold -- which only a
// per-sample loop can do; there's no native AudioNode for it. Holding for
// `holdSamples` samples before updating is equivalent to running at
// 1/holdSamples of the real sample rate: the classic "aliased, gritty
// lo-fi" half of a bitcrusher that BitcrusherEffect's own doc comment
// explicitly says it doesn't cover.

class SampleRateReducerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.holdSamples = 4;
    this.heldValues = [];
    // Shared across channels (not per-channel) so a stereo signal's hold
    // points land on the same sample index in every channel, rather than
    // drifting apart into an unintended ping-pong-ish artifact.
    this.counter = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "setHold") {
        this.holdSamples = Math.max(1, Math.round(event.data.holdSamples));
      }
    };
  }

  ensureChannels(count) {
    while (this.heldValues.length < count) this.heldValues.push(0);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const channelCount = Math.max(output.length, 1);
    this.ensureChannels(channelCount);

    const blockSize = output[0]?.length ?? 128;
    for (let i = 0; i < blockSize; i++) {
      const shouldUpdate = this.counter % this.holdSamples === 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const inputChannel = input[ch] ?? input[0];
        if (shouldUpdate) {
          this.heldValues[ch] = inputChannel ? inputChannel[i] : 0;
        }
        output[ch][i] = this.heldValues[ch];
      }
      this.counter++;
    }

    return true;
  }
}

registerProcessor("sample-rate-reducer-processor", SampleRateReducerProcessor);

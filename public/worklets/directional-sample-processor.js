// Runs in AudioWorkletGlobalScope. `sampleRate` and `currentTime` are globals
// provided by that scope and share the same clock as the main-thread
// AudioContext -- no clock translation needed between the two.
//
// Unlike granular-processor.js's grain cloud, this processor renders plain
// contiguous reads of a loaded buffer -- one "voice" per playVoice call, each
// reading forward or backward through its own [startFrame, endFrame] window
// at its own rate, with both stereo channels advancing together. It's the
// one piece of bruit-kit that can play audio backward: AudioBufferSourceNode
// (used by samplePlayer.ts) can't (Web Audio spec limitation -- no negative
// playbackRate), and granular-processor.js's grain rate math is structurally
// always positive too.

class DirectionalSampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {Float32Array | null} */
    this.left = null;
    /** @type {Float32Array | null} */
    this.right = null;
    this.frameCount = 0;

    // Sorted ascending by time; only ever contains events not yet applied.
    this.events = [];

    // Every currently-sounding voice, no note-number key needed (unlike
    // granular's activeVoices map) since a node can fire many overlapping
    // reads of itself with no notion of "the same note stealing itself".
    this.voices = [];

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "loadSample":
        this.left = msg.left;
        this.right = msg.right;
        this.frameCount = this.left.length;
        break;
      case "playVoice":
        this.insertEvent({
          time: msg.time ?? currentTime,
          type: "play",
          id: msg.id,
          startFraction: msg.startFraction,
          endFraction: msg.endFraction,
          direction: msg.direction,
          fadeMs: msg.fadeMs,
          rateSemitones: msg.rateSemitones,
        });
        break;
      case "stopVoice":
        this.insertEvent({
          time: msg.time ?? currentTime,
          type: "stop",
          id: msg.id,
        });
        break;
      case "panic":
        this.events = [];
        this.voices = [];
        break;
    }
  }

  insertEvent(ev) {
    this.events.push(ev);
    this.events.sort((a, b) => a.time - b.time);
  }

  applyEvent(ev) {
    if (ev.type === "play") {
      if (!this.frameCount) return;
      const lo = Math.min(ev.startFraction, ev.endFraction) * this.frameCount;
      const hi = Math.max(ev.startFraction, ev.endFraction) * this.frameCount;
      const spanFrames = Math.max(0, hi - lo);
      // Clamped away from 0 -- a runaway near-zero rate would make
      // totalFrames (spanFrames / rate) effectively infinite, hanging the
      // voice forever instead of just playing very slowly.
      const rate = Math.max(0.0001, 2 ** (ev.rateSemitones / 12));
      const fadeFrames = Math.max(
        0,
        Math.round(((ev.fadeMs ?? 4) / 1000) * sampleRate),
      );
      this.voices.push({
        id: ev.id,
        pos: ev.direction === "backward" ? hi : lo,
        step: (ev.direction === "backward" ? -1 : 1) * rate,
        elapsed: 0,
        totalFrames: spanFrames / rate,
        fadeFrames,
        stopping: false,
        stopGain: 1,
      });
    } else if (ev.type === "stop") {
      const voice = this.voices.find((v) => v.id === ev.id);
      if (voice) voice.stopping = true;
    }
  }

  render(outputL, outputR) {
    const blockSize = outputL.length;
    // Fixed-rate fallback release for an externally-stopped voice, used only
    // when its own declick fadeFrames would be too slow for a snappy stop
    // (e.g. fadeMs: 0) -- ~5ms, same declick order of magnitude as the rest
    // of bruit-kit's steal/release fades (see envelope.ts's STEAL_FADE_MS).
    const stopReleaseFrames = Math.max(1, Math.round(0.005 * sampleRate));

    for (let vIdx = this.voices.length - 1; vIdx >= 0; vIdx--) {
      const voice = this.voices[vIdx];
      let finished = false;

      for (let i = 0; i < blockSize; i++) {
        if (voice.elapsed >= voice.totalFrames) {
          finished = true;
          break;
        }
        const idx = Math.floor(voice.pos);
        // Guards both ends: idx >= 0 is the one granular-processor.js's own
        // interpolation doesn't need (its grain rate is always positive, so
        // srcPos only ever climbs) but this processor does, since a
        // backward voice's pos descends and can run past the buffer's start.
        if (idx < 0 || idx + 1 >= this.frameCount) {
          finished = true;
          break;
        }

        const frac = voice.pos - idx;
        const l = this.left[idx] * (1 - frac) + this.left[idx + 1] * frac;
        const r = this.right[idx] * (1 - frac) + this.right[idx + 1] * frac;

        const fadeIn =
          voice.fadeFrames > 0
            ? Math.min(1, voice.elapsed / voice.fadeFrames)
            : 1;
        const remaining = voice.totalFrames - voice.elapsed;
        const fadeOut =
          voice.fadeFrames > 0 ? Math.min(1, remaining / voice.fadeFrames) : 1;
        let gain = Math.min(fadeIn, fadeOut);

        if (voice.stopping) {
          voice.stopGain -= 1 / stopReleaseFrames;
          if (voice.stopGain <= 0) {
            finished = true;
            break;
          }
          gain *= voice.stopGain;
        }

        outputL[i] += l * gain;
        outputR[i] += r * gain;

        voice.pos += voice.step;
        voice.elapsed += 1;
      }

      if (finished) {
        this.voices.splice(vIdx, 1);
        this.port.postMessage({ type: "voiceEnded", id: voice.id });
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outputL = output[0];
    const outputR = output[1] ?? output[0];
    outputL.fill(0);
    if (outputR !== outputL) outputR.fill(0);

    // Same block-granularity event timing as granular-processor.js's own
    // event queue -- a scheduled voice starts at the top of whichever block
    // its time falls in, not sample-accurately mid-block.
    const blockDuration = outputL.length / sampleRate;
    const blockEndTime = currentTime + blockDuration;
    while (this.events.length > 0 && this.events[0].time <= blockEndTime) {
      this.applyEvent(this.events.shift());
    }

    this.render(outputL, outputR);
    return true;
  }
}

registerProcessor("directional-sample-processor", DirectionalSampleProcessor);

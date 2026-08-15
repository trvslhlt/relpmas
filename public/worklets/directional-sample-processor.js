// Runs in AudioWorkletGlobalScope. `sampleRate` and `currentTime` are globals
// provided by that scope and share the same clock as the main-thread
// AudioContext -- no clock translation needed between the two.
//
// Unlike granular-processor.js's grain cloud, this processor renders plain
// contiguous reads of a loaded buffer -- one "voice" per playVoice call, each
// reading forward or backward through its own [startFraction, endFraction]
// window at its own rate, with both stereo channels advancing together. It's
// the one piece of bruit-kit that can play audio backward: AudioBufferSourceNode
// (used by samplePlayer.ts) can't (Web Audio spec limitation -- no negative
// playbackRate), and granular-processor.js's grain rate math is structurally
// always positive too.
//
// startFraction/endFraction are directional, not a {lo,hi} bound: a voice
// always reads the span from startFraction to endFraction going forward
// (increasing index), wrapping past the buffer's end back to its start if
// endFraction < startFraction -- a true circular fragment, not clamped at
// the buffer boundary. `direction` picks which way playback actually reads
// that same span (backward starts at endFraction and descends toward
// startFraction, wrapping the other way). Buffer indexing is done modulo
// frameCount every sample, so this one formula covers both the wrapped and
// non-wrapped cases with no special-casing.

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
          // A plain Float32Array lookup table built on the main thread
          // (see DirectionalSamplePlayer.playVoice/buildEnvelopeTable) --
          // this processor never does curve math of its own, just indexes
          // into it. null means "no envelope," not "flat envelope at 1":
          // render() skips the multiply entirely rather than looking up a
          // table of all-1s, so the common case (no envelope) costs
          // nothing extra per sample.
          envelopeTable: msg.envelopeTable ?? null,
          // A single flat multiplier, decided by the caller before the
          // voice ever starts -- distinct from envelopeTable (a shape
          // that varies sample to sample). See
          // DirectionalSamplePlayer.playVoice's own gain doc comment.
          gain: msg.gain ?? 1,
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
      const n = this.frameCount;
      const startFrame = ev.startFraction * n;
      const endFrame = ev.endFraction * n;
      // Forward-wrap distance from start to end (always in [0, n)) -- this
      // is what makes startFraction > endFraction mean "wrap through the
      // buffer's end back to its start" instead of an unordered bound (see
      // the module doc comment).
      const spanFrames = (((endFrame - startFrame) % n) + n) % n;
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
        pos: ev.direction === "backward" ? endFrame : startFrame,
        step: (ev.direction === "backward" ? -1 : 1) * rate,
        elapsed: 0,
        totalFrames: spanFrames / rate,
        fadeFrames,
        envelopeTable: ev.envelopeTable,
        gain: ev.gain ?? 1,
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

    const n = this.frameCount;

    for (let vIdx = this.voices.length - 1; vIdx >= 0; vIdx--) {
      const voice = this.voices[vIdx];
      let finished = false;

      for (let i = 0; i < blockSize; i++) {
        if (voice.elapsed >= voice.totalFrames) {
          finished = true;
          break;
        }
        // Wrapped modulo n rather than stopped at the buffer's edge -- a
        // voice's span can run past the buffer's end (or, reading
        // backward, past its start) by design when startFraction/
        // endFraction describe a wrapped fragment (see applyEvent). frac
        // (the interpolation weight) is unaffected by wrapping since
        // Math.floor(voice.pos) and voice.pos always differ by the same
        // fractional amount regardless of any integer offset.
        const idx = Math.floor(voice.pos);
        const wrappedIdx = ((idx % n) + n) % n;
        const nextIdx = (wrappedIdx + 1) % n;
        const frac = voice.pos - idx;
        const l =
          this.left[wrappedIdx] * (1 - frac) + this.left[nextIdx] * frac;
        const r =
          this.right[wrappedIdx] * (1 - frac) + this.right[nextIdx] * frac;

        const fadeIn =
          voice.fadeFrames > 0
            ? Math.min(1, voice.elapsed / voice.fadeFrames)
            : 1;
        const remaining = voice.totalFrames - voice.elapsed;
        const fadeOut =
          voice.fadeFrames > 0 ? Math.min(1, remaining / voice.fadeFrames) : 1;
        let gain = Math.min(fadeIn, fadeOut);

        // Independent of, and multiplied together with, fadeIn/fadeOut
        // above -- fadeFrames is a fast fixed anti-click ramp at each end,
        // this is a separately-authored amplitude shape across the whole
        // voice (see DirectionalSamplePlayer.playVoice's own doc comment
        // on envelopeCurve). voice.totalFrames > 0 is guaranteed here (a
        // zero-span voice never gets pushed -- see applyEvent).
        if (voice.envelopeTable) {
          const table = voice.envelopeTable;
          const envPos = voice.elapsed / voice.totalFrames;
          const envIdx = Math.min(
            table.length - 1,
            Math.floor(envPos * (table.length - 1)),
          );
          gain *= table[envIdx];
        }

        // A flat multiplier decided once, before this voice started --
        // see DirectionalSamplePlayer.playVoice's own gain doc comment.
        gain *= voice.gain;

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

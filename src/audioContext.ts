import { LimiterEffect } from "bruit-kit/audio";

/** AudioContext starts suspended per browser autoplay policy; resolves once
 * a real user gesture has resumed it. Same pattern as bruit-kit's own demo
 * app (demo/shared/audioContext.ts) and grid-sequencer's own copy. */
export function unlockAudioContext(
  container: HTMLElement,
): Promise<AudioContext> {
  const audioContext = new AudioContext();
  if (audioContext.state === "running") {
    return Promise.resolve(audioContext);
  }
  return new Promise((resolve) => {
    const button = document.createElement("button");
    button.className = "unlock-button";
    button.textContent = "Click to enable audio";
    button.addEventListener("click", async () => {
      await audioContext.resume();
      button.remove();
      resolve(audioContext);
    });
    container.appendChild(button);
  });
}

const sharedLimiters = new WeakMap<AudioContext, LimiterEffect>();

/** Lazily creates (or reuses) the one LimiterEffect every node's output
 * (via the master bus, once it exists) routes through before destination,
 * so a hot mix of overlapping/cascading nodes can't hard-clip regardless of
 * any node's own levels. */
export function getSharedLimiter(audioContext: AudioContext): LimiterEffect {
  let limiter = sharedLimiters.get(audioContext);
  if (!limiter) {
    limiter = new LimiterEffect(audioContext);
    limiter.output.connect(audioContext.destination);
    sharedLimiters.set(audioContext, limiter);
  }
  return limiter;
}

/** Routes `node` through the shared limiter before destination. */
export function connectToOutput(
  node: AudioNode,
  audioContext: AudioContext,
): void {
  node.connect(getSharedLimiter(audioContext).input);
}

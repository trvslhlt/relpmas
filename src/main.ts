import {
  Recorder,
  audioBufferToWavBlob,
  preloadPitchShiftWorklet,
  preloadSampleRateReducerWorklet,
} from "bruit-kit/audio";
import {
  createMultiMarkerWaveformView,
  effectsFields,
  renderFields,
} from "bruit-kit/ui";
import { unlockAudioContext } from "./audioContext";
import { MasterBus } from "./masterBus";
import { createNodeMenu } from "./nodeMenu";
import { createPatchGraphView } from "./patchGraph";
import {
  createSampleNode,
  duplicateSampleNode,
  wrapFraction,
  wrappedLength,
} from "./sampleNode";
import { SampleNodeEngine } from "./sampleNodeEngine";

const unlockEl = document.querySelector<HTMLDivElement>("#unlock")!;
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const fileInputEl = document.querySelector<HTMLInputElement>("#file-input")!;
const waveformEl = document.querySelector<HTMLDivElement>("#waveform")!;
const addNodeButtonEl = document.querySelector<HTMLButtonElement>("#add-node")!;
const duplicateNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#duplicate-node")!;
const removeNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#remove-node")!;
const fireNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#fire-node")!;
const triggerNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#trigger-node")!;
const masterEffectsEl =
  document.querySelector<HTMLDivElement>("#master-effects")!;
const patchGraphEl = document.querySelector<HTMLDivElement>("#patch-graph")!;
const nodeMenuPanelEl =
  document.querySelector<HTMLElement>("#node-menu-panel")!;
const recordToggleButtonEl = document.querySelector<HTMLButtonElement>(
  "#record-toggle-button",
)!;
const recordIdleLabelEl =
  document.querySelector<HTMLSpanElement>("#record-idle-label")!;
const recordElapsedEl =
  document.querySelector<HTMLSpanElement>("#record-elapsed")!;
const downloadLinkEl =
  document.querySelector<HTMLAnchorElement>("#download-link")!;
const resetAudioButtonEl = document.querySelector<HTMLButtonElement>(
  "#reset-audio-button",
)!;

const NODE_COLORS = ["#ffb454", "#4c7dff", "#6fdc8c", "#ff6b9d", "#c792ea"];

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

unlockAudioContext(unlockEl).then(async (audioContext) => {
  const engine = new SampleNodeEngine(audioContext);
  // Both worklets must be registered before a node's effect chain can
  // include "Pitch shift" or "Sample Rate Reducer" -- each effect class's
  // own constructor is synchronous and throws immediately if its
  // processor isn't registered yet, which previously broke a node's
  // whole chain (left disconnected mid-rebuild) the instant either was
  // added, well after this point would have been too late to catch it.
  await Promise.all([
    engine.init(),
    preloadPitchShiftWorklet(audioContext),
    preloadSampleRateReducerWorklet(audioContext),
  ]);
  const masterBus = new MasterBus(audioContext, engine.output);

  // Recovers from a voice stuck forever mixing NaN into the graph (the
  // confirmed, reproduced way audio goes permanently silent -- see
  // SampleNodeEngine.clampRateMultiplier's own doc comment) or a
  // corrupted master effect's internal state -- see
  // SampleNodeEngine.panic()/MasterBus.panic()'s own doc comments for
  // exactly what each rebuilds. Neither touches any node's own
  // SampleNode data or the patch graph, so this is strictly less
  // destructive than the page reload it replaces (which would also lose
  // the loaded sample and the whole patch, since there's no save/load
  // persistence yet).
  resetAudioButtonEl.addEventListener("click", () => {
    engine.panic();
    masterBus.panic();
  });

  function syncMasterEffectsPanel(): void {
    renderFields(
      masterEffectsEl,
      effectsFields(
        () => masterBus.getEffects(),
        (next) => {
          masterBus.setEffects(next);
          syncMasterEffectsPanel();
        },
        (next) => masterBus.setEffectsLive(next),
      ),
    );
  }
  syncMasterEffectsPanel();

  // Taps the post-limiter master bus output -- "exactly what's heard,"
  // including every node's effects and the master chain, same as
  // bruit-kit's own demo recorder.
  const recorder = new Recorder(audioContext, masterBus.output);

  // One button carries both record and stop -- its own background color
  // (green/red, via these two classes) signals which action a click
  // performs next, rather than two separate buttons with one always
  // disabled. recordStartedAt/recordTimerHandle back the live elapsed
  // readout next to the button; both are cleared the moment recording
  // stops, at which point download-link takes over that same slot (see
  // the click handler below).
  let recordStartedAt: number | null = null;
  let recordTimerHandle: ReturnType<typeof setInterval> | null = null;

  recordToggleButtonEl.textContent = "●";
  recordToggleButtonEl.classList.add("is-idle");

  recordToggleButtonEl.addEventListener("click", async () => {
    if (recordToggleButtonEl.classList.contains("is-recording")) {
      if (recordTimerHandle !== null) clearInterval(recordTimerHandle);
      recordTimerHandle = null;
      recordStartedAt = null;
      recordElapsedEl.hidden = true;
      recordToggleButtonEl.classList.remove("is-recording");
      recordToggleButtonEl.classList.add("is-idle");
      recordToggleButtonEl.textContent = "●";
      recordToggleButtonEl.title = "Record";

      const { blob } = await recorder.stop();
      // MediaRecorder (inside Recorder) can't produce WAV directly --
      // decode whatever it did produce (webm/mp4) back into an
      // AudioBuffer, then re-encode that as WAV for a universally-
      // compatible download.
      const decoded = await audioContext.decodeAudioData(
        await blob.arrayBuffer(),
      );
      const wavBlob = audioBufferToWavBlob(decoded);
      const url = URL.createObjectURL(wavBlob);
      downloadLinkEl.href = url;
      downloadLinkEl.download = "relpmas-recording.wav";
      downloadLinkEl.textContent = "Download";
      downloadLinkEl.hidden = false;
    } else {
      recordIdleLabelEl.hidden = true;
      downloadLinkEl.hidden = true;
      recorder.start();
      recordStartedAt = Date.now();
      recordElapsedEl.textContent = "0:00";
      recordElapsedEl.hidden = false;
      recordTimerHandle = setInterval(() => {
        if (recordStartedAt === null) return;
        recordElapsedEl.textContent = formatElapsed(
          Date.now() - recordStartedAt,
        );
      }, 250);
      recordToggleButtonEl.classList.remove("is-idle");
      recordToggleButtonEl.classList.add("is-recording");
      recordToggleButtonEl.textContent = "■";
      recordToggleButtonEl.title = "Stop";
    }
  });

  const patchGraphView = createPatchGraphView(patchGraphEl, {
    onAddEdge: (fromNodeId, fromEvent, toNodeId) => {
      engine.addEdge(fromNodeId, fromEvent, toNodeId);
      syncPatchGraph();
    },
    onRemoveEdge: (edgeId) => {
      engine.removeEdge(edgeId);
      syncPatchGraph();
    },
    // The graph is the one place left a node can be selected now that
    // the separate node-list is gone (see selectNode's own doc comment).
    onSelect: (id) => selectNode(id, { openMenu: true }),
  });

  function syncPatchGraph(): void {
    patchGraphView.setNodes(
      engine.listNodes().map((node) => ({
        id: node.id,
        label: node.label,
        color: node.color,
      })),
    );
    patchGraphView.setEdges(engine.listEdges());
  }
  syncPatchGraph();

  engine.onNodeEvent((id) => {
    patchGraphView.flashNode(id);
  });

  let selectedId: string | null = null;

  // The one place a node's full param set lives now -- opened on demand
  // by clicking a node, docked as a persistent sidebar instead of an
  // always-visible panel per node (see nodeMenu.ts's own doc comment).
  const nodeMenu = createNodeMenu(engine, nodeMenuPanelEl, () => {
    updateNodeButtonsEnabled();
    syncWaveformEntries();
    syncPatchGraph();
  });

  const waveformView = createMultiMarkerWaveformView(waveformEl, {
    onChange: (id, position) => {
      const node = engine.getNode(id);
      if (!node) return;
      // The marker only ever shows/drags the range's *start* -- dragging
      // it translates the whole range, preserving whatever length is
      // currently set (see nodeMenu.ts's embedded zoomable waveform for
      // the only other way to change either boundary independently).
      // Dragging past the buffer's end wraps the fragment through to its
      // start rather than stopping the marker (see wrappedLength).
      const length = wrappedLength(node.range.start, node.range.end);
      const newEnd = wrapFraction(position + length);
      engine.updateNode(id, {
        range: { start: position, end: newEnd },
      });
      waveformView.setRange(id, { start: position, end: newEnd });
      nodeMenu.syncRange(id, { start: position, end: newEnd });
    },
    onSelect: (id) => selectNode(id, { openMenu: true }),
  });

  engine.onLiveRange((id, range) => {
    waveformView.setLiveMarker(id, range.start);
  });

  function syncWaveformEntries(): void {
    waveformView.setMarkers(
      engine.listNodes().map((node) => ({
        id: node.id,
        position: node.range.start,
        color: node.color,
        label: node.label,
        range: node.range,
      })),
    );
    waveformView.setSelected(selectedId);
    for (const node of engine.listNodes()) {
      const liveRange = engine.getLiveRange(node.id);
      waveformView.setLiveMarker(node.id, liveRange ? liveRange.start : null);
    }
  }

  // Add node stays enabled with nothing selected (it doesn't need a
  // selection); every other node-toolbar action operates on selectedId
  // and is meaningless without one.
  function updateNodeButtonsEnabled(): void {
    const disabled = selectedId === null;
    duplicateNodeButtonEl.disabled = disabled;
    removeNodeButtonEl.disabled = disabled;
    fireNodeButtonEl.disabled = disabled;
    triggerNodeButtonEl.disabled = disabled;
  }

  // The one place selectedId ever changes -- the waveform's own markers
  // and the patch graph's own node boxes are the two surfaces a node can
  // be picked from now that the separate node-list is gone (see
  // patchGraphView's own onSelect wiring above). openMenu is false for
  // add/duplicate/remove (selecting the newly-relevant node without
  // forcibly popping its menu open, matching this app's existing
  // behavior for those three) and true for an explicit click on a node
  // itself.
  function selectNode(
    id: string | null,
    options: { openMenu?: boolean } = {},
  ): void {
    selectedId = id;
    waveformView.setSelected(id);
    updateNodeButtonsEnabled();
    if (options.openMenu && id) nodeMenu.open(id);
  }

  fileInputEl.addEventListener("change", async () => {
    const file = fileInputEl.files?.[0];
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    await engine.loadSample(buffer);
    waveformView.setBuffer(buffer);
    nodeMenu.setBuffer(buffer);
    syncWaveformEntries();
  });

  addNodeButtonEl.addEventListener("click", async () => {
    const color = NODE_COLORS[engine.listNodes().length % NODE_COLORS.length];
    const node = createSampleNode(color);
    await engine.addNode(node);
    syncWaveformEntries();
    syncPatchGraph();
    selectNode(node.id);
  });

  duplicateNodeButtonEl.addEventListener("click", async () => {
    if (!selectedId) return;
    const source = engine.getNode(selectedId);
    if (!source) return;
    const color = NODE_COLORS[engine.listNodes().length % NODE_COLORS.length];
    const node = duplicateSampleNode(source, color);
    await engine.addNode(node);
    syncWaveformEntries();
    syncPatchGraph();
    selectNode(node.id);
  });

  removeNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    if (nodeMenu.isOpenFor(selectedId)) nodeMenu.close();
    engine.removeNode(selectedId);
    const remaining = engine.listNodes();
    syncWaveformEntries();
    syncPatchGraph();
    selectNode(remaining[0]?.id ?? null);
  });

  fireNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    engine.fireNow(selectedId);
  });

  triggerNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    engine.trigger(selectedId);
  });

  // Live range-motion markers keep updating even when nothing else
  // changes -- poll at a low rate rather than wiring a separate callback
  // for something purely cosmetic.
  setInterval(() => {
    for (const node of engine.listNodes()) {
      const liveRange = engine.getLiveRange(node.id);
      const livePosition = liveRange ? liveRange.start : null;
      waveformView.setLiveMarker(node.id, livePosition);
      nodeMenu.updateLiveMarker(node.id, livePosition);
    }
  }, 500);

  // Sets the node toolbar's own initial disabled state -- nothing else
  // calls updateNodeButtonsEnabled until the first user action (add/
  // select/etc.), so without this the buttons would start enabled with
  // no node selected instead of reflecting that empty state immediately.
  updateNodeButtonsEnabled();

  // Revealed only now, once every listener above (including the file
  // input's own) is wired -- revealing it as soon as the AudioContext
  // unlocked, before setup finished, left a real window where the file
  // input was visible and clickable but had no "change" listener yet, so
  // a fast file pick during that gap was silently lost.
  appEl.hidden = false;
});

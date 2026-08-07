import { Recorder, extensionForMimeType } from "bruit-kit/audio";
import type { Field } from "bruit-kit/ui";
import {
  createMultiRangeWaveformView,
  effectsFields,
  renderFields,
} from "bruit-kit/ui";
import { unlockAudioContext } from "./audioContext";
import { MasterBus } from "./masterBus";
import { createPatchGraphView } from "./patchGraph";
import {
  type ModulationRoute,
  type MotionConfig,
  type SampleNode,
  createSampleNode,
} from "./sampleNode";
import { SampleNodeEngine } from "./sampleNodeEngine";

const unlockEl = document.querySelector<HTMLDivElement>("#unlock")!;
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const fileInputEl = document.querySelector<HTMLInputElement>("#file-input")!;
const waveformEl = document.querySelector<HTMLDivElement>("#waveform")!;
const addNodeButtonEl = document.querySelector<HTMLButtonElement>("#add-node")!;
const removeNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#remove-node")!;
const fireNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#fire-node")!;
const triggerNodeButtonEl =
  document.querySelector<HTMLButtonElement>("#trigger-node")!;
const nodeListEl = document.querySelector<HTMLDivElement>("#node-list")!;
const nodeParamsEl = document.querySelector<HTMLDivElement>("#node-params")!;
const nodeEffectsEl = document.querySelector<HTMLDivElement>("#node-effects")!;
const masterEffectsEl =
  document.querySelector<HTMLDivElement>("#master-effects")!;
const patchGraphEl = document.querySelector<HTMLDivElement>("#patch-graph")!;
const recordButtonEl =
  document.querySelector<HTMLButtonElement>("#record-button")!;
const stopRecordButtonEl = document.querySelector<HTMLButtonElement>(
  "#stop-record-button",
)!;
const downloadLinkEl =
  document.querySelector<HTMLAnchorElement>("#download-link")!;

const NODE_COLORS = ["#ffb454", "#4c7dff", "#6fdc8c", "#ff6b9d", "#c792ea"];

unlockAudioContext(unlockEl).then(async (audioContext) => {
  appEl.hidden = false;

  const engine = new SampleNodeEngine(audioContext);
  await engine.init();
  const masterBus = new MasterBus(audioContext, engine.output);

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
  recordButtonEl.addEventListener("click", () => {
    recorder.start();
    recordButtonEl.disabled = true;
    stopRecordButtonEl.disabled = false;
    downloadLinkEl.hidden = true;
  });
  stopRecordButtonEl.addEventListener("click", async () => {
    const { blob, mimeType } = await recorder.stop();
    recordButtonEl.disabled = false;
    stopRecordButtonEl.disabled = true;
    const url = URL.createObjectURL(blob);
    downloadLinkEl.href = url;
    downloadLinkEl.download = `relpmas-recording.${extensionForMimeType(mimeType)}`;
    downloadLinkEl.textContent = "Download recording";
    downloadLinkEl.hidden = false;
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

  const waveformView = createMultiRangeWaveformView(waveformEl, {
    onChange: (id, range) => {
      engine.updateNode(id, { range });
    },
    onSelect: (id) => {
      selectedId = id;
      waveformView.setSelected(id);
      syncNodeList();
      syncParamsPanel();
      syncNodeEffectsPanel();
    },
  });

  engine.onLiveRange((id, range) => {
    waveformView.setLiveOverlay(id, range);
  });

  function syncWaveformEntries(): void {
    waveformView.setEntries(
      engine.listNodes().map((node) => ({
        id: node.id,
        range: node.range,
        color: node.color,
        label: node.label,
      })),
    );
    waveformView.setSelected(selectedId);
    for (const node of engine.listNodes()) {
      waveformView.setLiveOverlay(
        node.id,
        engine.getLiveRange(node.id) ?? null,
      );
    }
  }

  function syncNodeList(): void {
    nodeListEl.innerHTML = "";
    for (const node of engine.listNodes()) {
      const button = document.createElement("button");
      button.textContent = node.label + (engine.isArmed(node.id) ? " ●" : "");
      button.className = "node-list-button";
      button.style.borderColor = node.color;
      if (node.id === selectedId) button.classList.add("selected");
      button.addEventListener("click", () => {
        selectedId = node.id;
        waveformView.setSelected(node.id);
        syncNodeList();
        syncParamsPanel();
        syncNodeEffectsPanel();
      });
      nodeListEl.appendChild(button);
    }
  }

  function motionFields(
    node: SampleNode,
    key: "positionMotion" | "lengthMotion",
    labelPrefix: string,
    valueBounds: { min: number; max: number; step: number },
  ): Field[] {
    const config = node[key];
    const update = (patch: Partial<MotionConfig>) => {
      engine.updateNode(node.id, { [key]: { ...config, ...patch } });
    };
    return [
      {
        key: `${key}-mode`,
        label: `${labelPrefix} motion`,
        kind: "select",
        value: config.mode,
        options: ["none", "curve", "wander", "both"],
        onChange: (value) => update({ mode: value as MotionConfig["mode"] }),
      },
      {
        key: `${key}-min`,
        label: `${labelPrefix} min`,
        kind: "range",
        value: config.min,
        min: valueBounds.min,
        max: valueBounds.max,
        step: valueBounds.step,
        indented: true,
        onChange: (value) => update({ min: value }),
      },
      {
        key: `${key}-max`,
        label: `${labelPrefix} max`,
        kind: "range",
        value: config.max,
        min: valueBounds.min,
        max: valueBounds.max,
        step: valueBounds.step,
        indented: true,
        onChange: (value) => update({ max: value }),
      },
      {
        key: `${key}-wanderSpeed`,
        label: `${labelPrefix} wander speed`,
        kind: "range",
        value: config.wanderSpeed,
        min: 0,
        max: 1,
        step: 0.01,
        indented: true,
        onChange: (value) => update({ wanderSpeed: value }),
      },
      {
        key: `${key}-curveDuration`,
        label: `${labelPrefix} curve duration (s)`,
        kind: "range",
        value: config.curveDurationSeconds,
        min: 0.5,
        max: 20,
        step: 0.5,
        indented: true,
        onChange: (value) => update({ curveDurationSeconds: value }),
      },
      {
        key: `${key}-curve`,
        label: `${labelPrefix} curve`,
        kind: "automation",
        points: config.curvePoints,
        onChange: (points) => update({ curvePoints: points }),
      },
    ];
  }

  function modulationRouteFields(node: SampleNode): Field[] {
    const route = node.modulationRoute;
    const update = (patch: Partial<ModulationRoute>) => {
      engine.updateNode(node.id, {
        modulationRoute: { ...route, ...patch },
      });
    };
    return [
      {
        key: "mod-enabled",
        label: "Modulation route enabled",
        kind: "checkbox",
        value: route.enabled,
        onChange: (value) => update({ enabled: value }),
      },
      {
        key: "mod-effect-index",
        label: "Target effect index",
        kind: "number",
        value: route.targetEffectIndex,
        min: 0,
        max: 15,
        step: 1,
        indented: true,
        onChange: (value) => update({ targetEffectIndex: value }),
      },
      {
        key: "mod-param-key",
        label: "Target param (e.g. frequencyParam)",
        kind: "text",
        value: route.targetParamKey,
        onChange: (value) => update({ targetParamKey: value }),
      },
      {
        key: "mod-use-modulator",
        label: "Route through LFO (vs. direct sweep)",
        kind: "checkbox",
        value: route.useModulator,
        onChange: (value) => update({ useModulator: value }),
      },
      {
        key: "mod-duration",
        label: "Sweep duration (s)",
        kind: "range",
        value: route.durationSeconds,
        min: 0.05,
        max: 10,
        step: 0.05,
        indented: true,
        onChange: (value) => update({ durationSeconds: value }),
      },
      {
        key: "mod-value-min",
        label: route.useModulator ? "Rate min (Hz)" : "Value min",
        kind: "number",
        value: route.valueMin,
        step: 1,
        indented: true,
        onChange: (value) => update({ valueMin: value }),
      },
      {
        key: "mod-value-max",
        label: route.useModulator ? "Rate max (Hz)" : "Value max",
        kind: "number",
        value: route.valueMax,
        step: 1,
        indented: true,
        onChange: (value) => update({ valueMax: value }),
      },
      {
        key: "mod-curve",
        label: route.useModulator ? "LFO rate curve" : "Sweep curve",
        kind: "automation",
        points: route.curvePoints,
        onChange: (points) => update({ curvePoints: points }),
      },
      {
        key: "mod-depth-min",
        label: "LFO depth min",
        kind: "number",
        value: route.depthMin,
        step: 1,
        indented: true,
        onChange: (value) => update({ depthMin: value }),
      },
      {
        key: "mod-depth-max",
        label: "LFO depth max",
        kind: "number",
        value: route.depthMax,
        step: 1,
        indented: true,
        onChange: (value) => update({ depthMax: value }),
      },
      {
        key: "mod-depth-curve",
        label: "LFO depth curve",
        kind: "automation",
        points: route.depthCurvePoints,
        onChange: (points) => update({ depthCurvePoints: points }),
      },
    ];
  }

  function syncParamsPanel(): void {
    const node = selectedId ? engine.getNode(selectedId) : undefined;
    if (!node) {
      nodeParamsEl.innerHTML = "";
      return;
    }
    renderFields(nodeParamsEl, [
      {
        key: "label",
        label: "Name",
        kind: "text",
        value: node.label,
        onChange: (value) => {
          engine.updateNode(node.id, { label: value });
          syncNodeList();
          syncWaveformEntries();
          syncPatchGraph();
        },
      },
      {
        key: "armed",
        label: "Armed",
        kind: "checkbox",
        value: engine.isArmed(node.id),
        onChange: (value) => {
          engine.setArmed(node.id, value);
          syncNodeList();
        },
      },
      {
        key: "armMode",
        label: "Arm mode",
        kind: "select",
        value: node.armMode,
        options: ["manual", "loop"],
        onChange: (value) =>
          engine.updateNode(node.id, {
            armMode: value as SampleNode["armMode"],
          }),
      },
      {
        key: "loopFrequencyHz",
        label: "Loop frequency (Hz)",
        kind: "range",
        value: node.loopFrequencyHz,
        min: 0.1,
        max: 20,
        step: 0.1,
        indented: true,
        onChange: (value) =>
          engine.updateNode(node.id, { loopFrequencyHz: value }),
      },
      {
        key: "direction",
        label: "Direction",
        kind: "select",
        value: node.direction,
        options: ["forward", "backward", "alternating"],
        onChange: (value) =>
          engine.updateNode(node.id, {
            direction: value as SampleNode["direction"],
          }),
      },
      {
        key: "rateSemitones",
        label: "Rate (semitones)",
        kind: "range",
        value: node.rateSemitones,
        min: -24,
        max: 24,
        step: 1,
        onChange: (value) =>
          engine.updateNode(node.id, { rateSemitones: value }),
      },
      {
        key: "fadeMs",
        label: "Declick fade (ms)",
        kind: "range",
        value: node.fadeMs,
        min: 0,
        max: 50,
        step: 1,
        onChange: (value) => engine.updateNode(node.id, { fadeMs: value }),
      },
      {
        key: "firingPattern",
        label: "Firing pattern",
        kind: "select",
        value: node.firingPattern,
        options: ["single", "curveSpaced"],
        onChange: (value) =>
          engine.updateNode(node.id, {
            firingPattern: value as SampleNode["firingPattern"],
          }),
      },
      {
        key: "fireCount",
        label: "Fire count",
        kind: "number",
        value: node.fireCount,
        min: 1,
        max: 64,
        step: 1,
        indented: true,
        onChange: (value) => engine.updateNode(node.id, { fireCount: value }),
      },
      {
        key: "intervalMinMs",
        label: "Interval min (ms)",
        kind: "number",
        value: node.intervalMinMs,
        min: 1,
        max: 5000,
        step: 1,
        indented: true,
        onChange: (value) =>
          engine.updateNode(node.id, { intervalMinMs: value }),
      },
      {
        key: "intervalMaxMs",
        label: "Interval max (ms)",
        kind: "number",
        value: node.intervalMaxMs,
        min: 1,
        max: 5000,
        step: 1,
        indented: true,
        onChange: (value) =>
          engine.updateNode(node.id, { intervalMaxMs: value }),
      },
      {
        key: "intervalCurve",
        label: "Interval curve (per fire)",
        kind: "automation",
        points: node.intervalCurve,
        onChange: (points) =>
          engine.updateNode(node.id, { intervalCurve: points }),
      },
      ...motionFields(node, "positionMotion", "Position", {
        min: 0,
        max: 1,
        step: 0.01,
      }),
      ...motionFields(node, "lengthMotion", "Length", {
        min: 0,
        max: 1,
        step: 0.01,
      }),
      ...modulationRouteFields(node),
    ]);
  }

  function syncNodeEffectsPanel(): void {
    const node = selectedId ? engine.getNode(selectedId) : undefined;
    if (!node) {
      nodeEffectsEl.innerHTML = "";
      return;
    }
    renderFields(
      nodeEffectsEl,
      effectsFields(
        () => engine.getNode(node.id)?.effects ?? [],
        (next) => {
          engine.setNodeEffects(node.id, next);
          syncNodeEffectsPanel();
        },
        (next) => engine.setNodeEffectsLive(node.id, next),
      ),
    );
  }

  fileInputEl.addEventListener("change", async () => {
    const file = fileInputEl.files?.[0];
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    await engine.loadSample(buffer);
    waveformView.setBuffer(buffer);
    syncWaveformEntries();
  });

  addNodeButtonEl.addEventListener("click", async () => {
    const color = NODE_COLORS[engine.listNodes().length % NODE_COLORS.length];
    const node = createSampleNode(color);
    await engine.addNode(node);
    selectedId = node.id;
    syncWaveformEntries();
    syncNodeList();
    syncParamsPanel();
    syncNodeEffectsPanel();
    syncPatchGraph();
  });

  removeNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    engine.removeNode(selectedId);
    const remaining = engine.listNodes();
    selectedId = remaining[0]?.id ?? null;
    syncWaveformEntries();
    syncNodeList();
    syncParamsPanel();
    syncNodeEffectsPanel();
    syncPatchGraph();
  });

  fireNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    engine.fireNow(selectedId);
  });

  triggerNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    engine.trigger(selectedId);
  });

  // Live range-motion overlays and the "armed" dot on the node-list button
  // keep updating even when nothing else changes -- poll the list label at
  // a low rate rather than wiring a separate callback for something purely
  // cosmetic.
  setInterval(syncNodeList, 500);
});

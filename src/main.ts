import { Recorder, extensionForMimeType } from "bruit-kit/audio";
import {
  createMultiMarkerWaveformView,
  effectsFields,
  renderFields,
} from "bruit-kit/ui";
import { unlockAudioContext } from "./audioContext";
import { MasterBus } from "./masterBus";
import { createNodeMenu } from "./nodeMenu";
import { createPatchGraphView } from "./patchGraph";
import { createSampleNode } from "./sampleNode";
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
const masterEffectsEl =
  document.querySelector<HTMLDivElement>("#master-effects")!;
const patchGraphEl = document.querySelector<HTMLDivElement>("#patch-graph")!;
const nodeMenuPanelEl =
  document.querySelector<HTMLElement>("#node-menu-panel")!;
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

  // The one place a node's full param set lives now -- opened on demand
  // via right-click, docked as a persistent sidebar instead of an
  // always-visible panel per node (see nodeMenu.ts's own doc comment).
  const nodeMenu = createNodeMenu(engine, nodeMenuPanelEl, () => {
    syncNodeList();
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
      const length = node.range.end - node.range.start;
      const clampedStart = Math.min(
        Math.max(position, 0),
        Math.max(0, 1 - length),
      );
      engine.updateNode(id, {
        range: { start: clampedStart, end: clampedStart + length },
      });
      // The widget already moved the marker to the raw (pre-length-clamp)
      // position during the drag -- correct it if the clamp above kicked in.
      waveformView.setPosition(id, clampedStart);
    },
    onSelect: (id) => {
      selectedId = id;
      waveformView.setSelected(id);
      syncNodeList();
    },
    onContextMenu: (id) => {
      selectedId = id;
      waveformView.setSelected(id);
      syncNodeList();
      nodeMenu.open(id);
    },
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
      })),
    );
    waveformView.setSelected(selectedId);
    for (const node of engine.listNodes()) {
      const liveRange = engine.getLiveRange(node.id);
      waveformView.setLiveMarker(node.id, liveRange ? liveRange.start : null);
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
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        selectedId = node.id;
        waveformView.setSelected(node.id);
        syncNodeList();
        nodeMenu.open(node.id);
      });
      nodeListEl.appendChild(button);
    }
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
    syncPatchGraph();
  });

  removeNodeButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    if (nodeMenu.isOpenFor(selectedId)) nodeMenu.close();
    engine.removeNode(selectedId);
    const remaining = engine.listNodes();
    selectedId = remaining[0]?.id ?? null;
    syncWaveformEntries();
    syncNodeList();
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

  // Live range-motion markers and the "armed" dot on the node-list button
  // keep updating even when nothing else changes -- poll at a low rate
  // rather than wiring a separate callback for something purely cosmetic.
  setInterval(() => {
    syncNodeList();
    for (const node of engine.listNodes()) {
      const liveRange = engine.getLiveRange(node.id);
      const livePosition = liveRange ? liveRange.start : null;
      waveformView.setLiveMarker(node.id, livePosition);
      nodeMenu.updateLiveMarker(node.id, livePosition);
    }
  }, 500);
});

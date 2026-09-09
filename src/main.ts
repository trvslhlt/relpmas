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
import { deletePreset, listPresets, savePreset } from "./nodePresets";
import { createPatchGraphView } from "./patchGraph";
import {
  createSampleNode,
  createSampleNodeFromPreset,
  duplicateSampleNode,
  wrapFraction,
  wrappedLength,
} from "./sampleNode";
import { SampleNodeEngine } from "./sampleNodeEngine";

const unlockEl = document.querySelector<HTMLDivElement>("#unlock")!;
const appEl = document.querySelector<HTMLDivElement>("#app")!;
const fileInputEl = document.querySelector<HTMLInputElement>("#file-input")!;
const fileReplaceInputEl = document.querySelector<HTMLInputElement>(
  "#file-replace-input",
)!;
const fileTabsEl = document.querySelector<HTMLDivElement>("#file-tabs")!;
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
const savePresetButtonEl =
  document.querySelector<HTMLButtonElement>("#save-preset")!;
const loadPresetButtonEl =
  document.querySelector<HTMLButtonElement>("#load-preset")!;
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
    // Live, per slider-input event (see PatchGraphViewOptions.onSetProbability's
    // own doc comment) -- patchGraph.ts already redraws that one edge's own
    // opacity/label itself, so no syncPatchGraph() call is needed here.
    onSetProbability: (edgeId, probability) =>
      engine.setEdgeProbability(edgeId, probability),
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
  /** Which of the engine's loaded files (SampleNodeEngine.listFiles) the
   * main overview waveform is currently showing -- switchable via the
   * file-tabs row (syncFileTabs/switchToFile), independent of any
   * individual node's own fileId. New nodes default to whichever file is
   * active when Add is clicked. */
  let activeFileId: string | null = null;
  let nextFileId = 1;
  /** Which file's own audio a pick from fileReplaceInputEl (see the
   * file-tab-replace button above) should land on -- set right before
   * that hidden input is programmatically clicked, since the resulting
   * "change" event carries no reference back to which tab triggered it. */
  let replaceTargetFileId: string | null = null;

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

  // Only forwarded to the main overview waveform when the node whose
  // range just moved is actually on the currently-active file -- a node
  // on some other (currently hidden) file still drifts normally in the
  // engine, it just has nothing on-screen here to push a marker onto.
  engine.onLiveRange((id, range) => {
    const node = engine.getNode(id);
    if (!node || node.fileId !== activeFileId) return;
    waveformView.setLiveMarker(id, range.start);
  });

  // Renders the file-tabs row from the engine's own file list -- one tab
  // per loaded file, the active one highlighted, each with its own remove
  // action (blocked -- see engine.removeFile's own doc comment -- while
  // any node still references it).
  function syncFileTabs(): void {
    fileTabsEl.innerHTML = "";
    for (const file of engine.listFiles()) {
      const tab = document.createElement("div");
      tab.className = "file-tab";
      if (file.id === activeFileId) tab.classList.add("is-active");

      const label = document.createElement("button");
      label.type = "button";
      label.className = "file-tab-label";
      label.textContent = file.label;
      label.addEventListener("click", () => switchToFile(file.id));
      tab.appendChild(label);

      const replaceButton = document.createElement("button");
      replaceButton.type = "button";
      replaceButton.className = "file-tab-replace";
      replaceButton.title = "Replace audio (keeps nodes and their positions)";
      replaceButton.textContent = "⇄";
      replaceButton.addEventListener("click", () => {
        replaceTargetFileId = file.id;
        fileReplaceInputEl.click();
      });
      tab.appendChild(replaceButton);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "file-tab-remove";
      removeButton.title = "Remove file";
      removeButton.textContent = "×";
      removeButton.addEventListener("click", () => {
        const removed = engine.removeFile(file.id);
        if (!removed) {
          window.alert(
            `"${file.label}" is still used by one or more nodes -- reassign or remove them first.`,
          );
          return;
        }
        if (activeFileId === file.id) {
          const remaining = engine.listFiles();
          if (remaining[0]) {
            switchToFile(remaining[0].id);
          } else {
            activeFileId = null;
            syncFileTabs();
            syncWaveformEntries();
            updateNodeButtonsEnabled();
          }
        } else {
          syncFileTabs();
        }
      });
      tab.appendChild(removeButton);

      fileTabsEl.appendChild(tab);
    }
  }

  // Makes `fileId` the one the main overview waveform shows -- swaps its
  // buffer and re-filters which nodes' markers appear on it (see
  // syncWaveformEntries). A no-op if the file doesn't actually exist.
  function switchToFile(fileId: string): void {
    const buffer = engine.getBuffer(fileId);
    if (!buffer) return;
    activeFileId = fileId;
    waveformView.setBuffer(buffer);
    syncFileTabs();
    syncWaveformEntries();
    updateNodeButtonsEnabled();
  }

  function syncWaveformEntries(): void {
    const activeNodes = engine
      .listNodes()
      .filter((node) => node.fileId === activeFileId);
    waveformView.setMarkers(
      activeNodes.map((node) => ({
        id: node.id,
        position: node.range.start,
        color: node.color,
        label: node.label,
        range: node.range,
      })),
    );
    waveformView.setSelected(selectedId);
    for (const node of activeNodes) {
      const liveRange = engine.getLiveRange(node.id);
      waveformView.setLiveMarker(node.id, liveRange ? liveRange.start : null);
    }
  }

  // Add node stays enabled with nothing selected (it doesn't need a
  // selection); every other node-toolbar action operates on selectedId
  // and is meaningless without one. Add node additionally needs a file to
  // put the new node on.
  function updateNodeButtonsEnabled(): void {
    const disabled = selectedId === null;
    duplicateNodeButtonEl.disabled = disabled;
    removeNodeButtonEl.disabled = disabled;
    fireNodeButtonEl.disabled = disabled;
    triggerNodeButtonEl.disabled = disabled;
    savePresetButtonEl.disabled = disabled;
    addNodeButtonEl.disabled = activeFileId === null;
    // loadPresetButtonEl stays enabled either way -- its own "New node"
    // action is disabled per-row instead when there's no active file (see
    // openLoadPresetModal).
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
    // Selecting a node on a file other than the one currently shown
    // brings that file into view first -- otherwise the selected node
    // would have no marker visible anywhere to reflect the selection.
    // switchToFile already covers setSelected/updateNodeButtonsEnabled
    // (via syncWaveformEntries) when it actually switches.
    const node = id ? engine.getNode(id) : null;
    if (node && node.fileId !== activeFileId) {
      switchToFile(node.fileId);
    } else {
      waveformView.setSelected(id);
      updateNodeButtonsEnabled();
    }
    if (options.openMenu && id) nodeMenu.open(id);
  }

  fileInputEl.addEventListener("change", async () => {
    const files = fileInputEl.files;
    if (!files || files.length === 0) return;
    let lastFileId: string | null = null;
    for (const file of Array.from(files)) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = await audioContext.decodeAudioData(arrayBuffer);
      const fileId = `file-${nextFileId++}`;
      engine.addFile(fileId, file.name, buffer);
      lastFileId = fileId;
    }
    // Clears the input so picking the exact same file(s) again later still
    // fires a "change" event (the browser otherwise treats an unchanged
    // file selection as a no-op).
    fileInputEl.value = "";
    syncFileTabs();
    if (lastFileId) switchToFile(lastFileId);
  });

  // Swaps a file's own buffer/label in place (see engine.replaceFile's own
  // doc comment) rather than adding a new file -- every node already
  // assigned to fileId keeps that same fileId and its range's fractions
  // untouched, so this is how a source recording gets replaced with a
  // fresh take without having to rebuild the patch on top of it.
  fileReplaceInputEl.addEventListener("change", async () => {
    const fileId = replaceTargetFileId;
    const file = fileReplaceInputEl.files?.[0];
    fileReplaceInputEl.value = "";
    replaceTargetFileId = null;
    if (!fileId || !file) return;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(arrayBuffer);
    await engine.replaceFile(fileId, buffer, file.name);
    syncFileTabs();
    if (fileId === activeFileId) waveformView.setBuffer(buffer);
    nodeMenu.refreshWaveformIfShowing(fileId);
  });

  addNodeButtonEl.addEventListener("click", async () => {
    if (!activeFileId) return;
    const color = NODE_COLORS[engine.listNodes().length % NODE_COLORS.length];
    const fileDurationSeconds =
      engine.getBuffer(activeFileId)?.duration ?? null;
    const node = createSampleNode(color, activeFileId, fileDurationSeconds);
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

  savePresetButtonEl.addEventListener("click", () => {
    if (!selectedId) return;
    const node = engine.getNode(selectedId);
    if (!node) return;
    // A native prompt rather than new modal chrome -- this is a rare,
    // one-field action, not worth building a text-input popup for.
    const name = window.prompt("Save this node's config as:", node.label);
    if (!name) return;
    savePreset(name, node);
  });

  loadPresetButtonEl.addEventListener("click", () => openLoadPresetModal());

  /** Lists every saved node preset (see nodePresets.ts) with two ways to
   * bring one into the current patch: as a brand new node (always
   * available, same "no selection needed" convention as Add), or applied
   * onto the currently selected node's own config (only when one is
   * selected) -- plus a delete action per row. Reuses the same .modal-*
   * chrome patchGraph.ts's own probability popup and nodeMenu.ts's
   * motion config grid already use, rather than inventing new popup
   * styling for a third time. */
  function openLoadPresetModal(): void {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    const modal = document.createElement("div");
    modal.className = "modal";
    overlay.appendChild(modal);

    const header = document.createElement("div");
    header.className = "modal-header";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.textContent = "Load node preset";
    const closeButton = document.createElement("button");
    closeButton.className = "modal-close-button";
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => close());
    header.append(title, closeButton);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body preset-list";
    modal.appendChild(body);
    renderRows();

    function renderRows(): void {
      body.innerHTML = "";
      const presets = listPresets();
      if (presets.length === 0) {
        const empty = document.createElement("p");
        empty.className = "app-note";
        empty.textContent = "No saved presets yet.";
        body.appendChild(empty);
        return;
      }
      for (const preset of presets) {
        const row = document.createElement("div");
        row.className = "preset-row";

        const info = document.createElement("div");
        info.className = "preset-row-info";
        const nameEl = document.createElement("div");
        nameEl.className = "preset-row-name";
        nameEl.textContent = preset.name;
        const dateEl = document.createElement("div");
        dateEl.className = "preset-row-date";
        dateEl.textContent = new Date(preset.createdAt).toLocaleString();
        info.append(nameEl, dateEl);
        row.appendChild(info);

        const actions = document.createElement("div");
        actions.className = "preset-row-actions";

        const newNodeButton = document.createElement("button");
        newNodeButton.textContent = "New node";
        // A preset is file-independent (see nodePresets.ts's own doc
        // comment) -- needs at least one loaded file to land the new node
        // on, same requirement Add itself has.
        newNodeButton.disabled = activeFileId === null;
        newNodeButton.addEventListener("click", async () => {
          if (!activeFileId) return;
          const color =
            NODE_COLORS[engine.listNodes().length % NODE_COLORS.length];
          const node = createSampleNodeFromPreset(
            preset.data,
            color,
            preset.name,
            activeFileId,
          );
          await engine.addNode(node);
          syncWaveformEntries();
          syncPatchGraph();
          selectNode(node.id);
          close();
        });
        actions.appendChild(newNodeButton);

        const applyButton = document.createElement("button");
        applyButton.textContent = "Apply to selected";
        applyButton.disabled = selectedId === null;
        applyButton.addEventListener("click", () => {
          if (!selectedId) return;
          engine.updateNode(selectedId, preset.data);
          syncWaveformEntries();
          syncPatchGraph();
          if (nodeMenu.isOpenFor(selectedId)) nodeMenu.open(selectedId);
          close();
        });
        actions.appendChild(applyButton);

        const deleteButton = document.createElement("button");
        deleteButton.className = "icon-button";
        deleteButton.title = "Delete preset";
        deleteButton.textContent = "×";
        deleteButton.addEventListener("click", () => {
          deletePreset(preset.name);
          renderRows();
        });
        actions.appendChild(deleteButton);

        row.appendChild(actions);
        body.appendChild(row);
      }
    }

    function close(): void {
      overlay.remove();
    }

    document.body.appendChild(overlay);
  }

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
      // The main overview waveform only ever shows the active file's own
      // markers (see syncWaveformEntries) -- nodeMenu.updateLiveMarker
      // already gates itself on whichever node its own menu is open for,
      // so it needs no such filter here.
      if (node.fileId === activeFileId) {
        waveformView.setLiveMarker(node.id, livePosition);
      }
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

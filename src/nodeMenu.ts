// The right-click params panel for one node -- everything that used to be
// an always-visible section (arm/trigger/fire config, range motion,
// modulation route, effect chain) lives here instead, docked as a
// persistent sidebar (see index.html's #node-menu-panel) rather than a
// small popup, opened on demand by right-clicking a node. A single
// instance is reused across every node; opening a different node's menu
// re-renders this same panel's contents rather than creating a new one.
//
// The header/waveform/params/effects sections are built once and kept as
// persistent DOM children of the panel -- render() updates their content
// in place (mostly via renderFields, which already does its own
// container.innerHTML reset internally) rather than tearing down the
// whole panel every time, specifically so the embedded zoomable waveform
// (see ensureWaveform) keeps its zoom/pan state across an unrelated
// re-render (e.g. adding an effect), rather than snapping back to fully
// zoomed out every time.

import {
  type Field,
  createZoomableWaveformRangeView,
  effectsFields,
  renderFields,
} from "bruit-kit/ui";
import type { ModulationRoute, MotionConfig, SampleNode } from "./sampleNode";
import type { SampleNodeEngine } from "./sampleNodeEngine";

export interface NodeMenuHandle {
  open(id: string): void;
  close(): void;
  isOpenFor(id: string): boolean;
  /** Pushes a live (motion-drifted) start position onto the embedded
   * waveform's marker, if this menu is currently open for `id` -- a no-op
   * otherwise, so a caller can call this unconditionally from its own
   * polling loop without checking isOpenFor itself first. */
  updateLiveMarker(id: string, position: number | null): void;
}

export function createNodeMenu(
  engine: SampleNodeEngine,
  panelEl: HTMLElement,
  onNodeChanged: () => void,
): NodeMenuHandle {
  let currentId: string | null = null;

  const header = document.createElement("div");
  header.className = "node-menu-header";
  const swatch = document.createElement("span");
  swatch.className = "node-menu-swatch";
  const title = document.createElement("span");
  title.className = "node-menu-title";
  const closeButton = document.createElement("button");
  closeButton.textContent = "×";
  closeButton.className = "node-menu-close";
  closeButton.addEventListener("click", () => close());
  header.append(swatch, title, closeButton);

  const waveformContainer = document.createElement("div");
  waveformContainer.className = "node-menu-waveform";

  const paramsBody = document.createElement("div");

  const effectsHeading = document.createElement("h3");
  effectsHeading.className = "node-menu-subheading";
  effectsHeading.textContent = "Effects";

  const effectsBody = document.createElement("div");

  panelEl.append(
    header,
    waveformContainer,
    paramsBody,
    effectsHeading,
    effectsBody,
  );

  let zoomableView: ReturnType<typeof createZoomableWaveformRangeView> | null =
    null;
  let waveformNodeId: string | null = null;

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  function close(): void {
    panelEl.hidden = true;
    currentId = null;
    document.removeEventListener("keydown", handleKeydown, true);
  }

  function update(patch: Partial<SampleNode>): void {
    if (!currentId) return;
    engine.updateNode(currentId, patch);
    onNodeChanged();
  }

  function motionFields(
    node: SampleNode,
    key: "positionMotion" | "lengthMotion",
    labelPrefix: string,
  ): Field[] {
    const config = node[key];
    const updateMotion = (patch: Partial<MotionConfig>) =>
      update({ [key]: { ...config, ...patch } });
    return [
      {
        key: `${key}-mode`,
        label: `${labelPrefix} motion`,
        kind: "select",
        value: config.mode,
        options: ["none", "curve", "wander", "both"],
        onChange: (value) =>
          updateMotion({ mode: value as MotionConfig["mode"] }),
      },
      {
        key: `${key}-min`,
        label: `${labelPrefix} min`,
        kind: "range",
        value: config.min,
        min: 0,
        max: 1,
        step: 0.01,
        indented: true,
        onChange: (value) => updateMotion({ min: value }),
      },
      {
        key: `${key}-max`,
        label: `${labelPrefix} max`,
        kind: "range",
        value: config.max,
        min: 0,
        max: 1,
        step: 0.01,
        indented: true,
        onChange: (value) => updateMotion({ max: value }),
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
        onChange: (value) => updateMotion({ wanderSpeed: value }),
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
        onChange: (value) => updateMotion({ curveDurationSeconds: value }),
      },
      {
        key: `${key}-curve`,
        label: `${labelPrefix} curve`,
        kind: "automation",
        points: config.curvePoints,
        onChange: (points) => updateMotion({ curvePoints: points }),
      },
    ];
  }

  function modulationRouteFields(node: SampleNode): Field[] {
    const route = node.modulationRoute;
    const updateRoute = (patch: Partial<ModulationRoute>) =>
      update({ modulationRoute: { ...route, ...patch } });
    return [
      {
        key: "mod-enabled",
        label: "Modulation route enabled",
        kind: "checkbox",
        value: route.enabled,
        onChange: (value) => updateRoute({ enabled: value }),
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
        onChange: (value) => updateRoute({ targetEffectIndex: value }),
      },
      {
        key: "mod-param-key",
        label: "Target param (e.g. frequencyParam)",
        kind: "text",
        value: route.targetParamKey,
        onChange: (value) => updateRoute({ targetParamKey: value }),
      },
      {
        key: "mod-use-modulator",
        label: "Route through LFO (vs. direct sweep)",
        kind: "checkbox",
        value: route.useModulator,
        onChange: (value) => updateRoute({ useModulator: value }),
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
        onChange: (value) => updateRoute({ durationSeconds: value }),
      },
      {
        key: "mod-value-min",
        label: route.useModulator ? "Rate min (Hz)" : "Value min",
        kind: "number",
        value: route.valueMin,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMin: value }),
      },
      {
        key: "mod-value-max",
        label: route.useModulator ? "Rate max (Hz)" : "Value max",
        kind: "number",
        value: route.valueMax,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ valueMax: value }),
      },
      {
        key: "mod-curve",
        label: route.useModulator ? "LFO rate curve" : "Sweep curve",
        kind: "automation",
        points: route.curvePoints,
        onChange: (points) => updateRoute({ curvePoints: points }),
      },
      {
        key: "mod-depth-min",
        label: "LFO depth min",
        kind: "number",
        value: route.depthMin,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ depthMin: value }),
      },
      {
        key: "mod-depth-max",
        label: "LFO depth max",
        kind: "number",
        value: route.depthMax,
        step: 1,
        indented: true,
        onChange: (value) => updateRoute({ depthMax: value }),
      },
      {
        key: "mod-depth-curve",
        label: "LFO depth curve",
        kind: "automation",
        points: route.depthCurvePoints,
        onChange: (points) => updateRoute({ depthCurvePoints: points }),
      },
    ];
  }

  function paramFields(node: SampleNode): Field[] {
    return [
      {
        key: "label",
        label: "Name",
        kind: "text",
        value: node.label,
        onChange: (value) => update({ label: value }),
      },
      {
        key: "armed",
        label: "Armed",
        kind: "checkbox",
        value: engine.isArmed(node.id),
        onChange: (value) => {
          engine.setArmed(node.id, value);
          onNodeChanged();
        },
      },
      {
        key: "armMode",
        label: "Arm mode",
        kind: "select",
        value: node.armMode,
        options: ["manual", "loop"],
        onChange: (value) =>
          update({ armMode: value as SampleNode["armMode"] }),
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
        onChange: (value) => update({ loopFrequencyHz: value }),
      },
      {
        key: "direction",
        label: "Direction",
        kind: "select",
        value: node.direction,
        options: ["forward", "backward", "alternating"],
        onChange: (value) =>
          update({ direction: value as SampleNode["direction"] }),
      },
      {
        key: "rateSemitones",
        label: "Rate (semitones)",
        kind: "range",
        value: node.rateSemitones,
        min: -24,
        max: 24,
        step: 1,
        onChange: (value) => update({ rateSemitones: value }),
      },
      {
        key: "fadeMs",
        label: "Declick fade (ms)",
        kind: "range",
        value: node.fadeMs,
        min: 0,
        max: 50,
        step: 1,
        onChange: (value) => update({ fadeMs: value }),
      },
      {
        key: "firingPattern",
        label: "Firing pattern",
        kind: "select",
        value: node.firingPattern,
        options: ["single", "curveSpaced"],
        onChange: (value) =>
          update({ firingPattern: value as SampleNode["firingPattern"] }),
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
        onChange: (value) => update({ fireCount: value }),
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
        onChange: (value) => update({ intervalMinMs: value }),
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
        onChange: (value) => update({ intervalMaxMs: value }),
      },
      {
        key: "intervalCurve",
        label: "Interval curve (per fire)",
        kind: "automation",
        points: node.intervalCurve,
        onChange: (points) => update({ intervalCurve: points }),
      },
      ...motionFields(node, "positionMotion", "Position"),
      ...motionFields(node, "lengthMotion", "Length"),
      ...modulationRouteFields(node),
    ];
  }

  /** (Re)creates the embedded zoomable range view only when switching to a
   * different node than whatever it was last built for -- re-rendering
   * the rest of the panel (e.g. after an effect add/remove) must not reset
   * an in-progress zoom/pan on the same node's own waveform. */
  function ensureWaveform(node: SampleNode): void {
    if (waveformNodeId === node.id && zoomableView) {
      // Still the same node -- just make sure the range reflects any
      // external change (e.g. dragged on the main overview waveform)
      // without touching zoom/pan.
      zoomableView.setRange(node.range);
      return;
    }
    zoomableView = createZoomableWaveformRangeView(waveformContainer, {
      initialRange: node.range,
      onChange: (range) => update({ range }),
    });
    const buffer = engine.getBuffer();
    if (buffer) zoomableView.setBuffer(buffer);
    waveformNodeId = node.id;
  }

  function render(): void {
    if (!currentId) return;
    const node = engine.getNode(currentId);
    if (!node) {
      close();
      return;
    }

    swatch.style.background = node.color;
    title.textContent = node.label;

    ensureWaveform(node);

    renderFields(paramsBody, paramFields(node));
    renderFields(
      effectsBody,
      effectsFields(
        () => engine.getNode(node.id)?.effects ?? [],
        (next) => {
          engine.setNodeEffects(node.id, next);
          render();
        },
        (next) => engine.setNodeEffectsLive(node.id, next),
      ),
    );
  }

  return {
    open(id) {
      currentId = id;
      panelEl.hidden = false;
      document.addEventListener("keydown", handleKeydown, true);
      render();
    },
    close,
    isOpenFor(id) {
      return currentId === id && !panelEl.hidden;
    },
    updateLiveMarker(id, position) {
      if (id === currentId) zoomableView?.setLiveMarker(position);
    },
  };
}
